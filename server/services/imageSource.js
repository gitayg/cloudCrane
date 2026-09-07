import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Deploying a prebuilt image instead of building one.
//
// Every other source type hands the deployer a tree of files. This one hands it
// a name, and the name is the whole attack surface: it comes from an operator
// typing into a form, it selects what code runs on the box, and it is the only
// thing standing between "run odoo:19" and "run whatever the string says".
//
// Two separate jobs here, and only the second is about safety.
//
// 1. Parsing. A reference is `[registry/]path[:tag][@digest]` and the pieces
//    are not separated by unambiguous characters — the ':' in 'localhost:5000'
//    is a port and the ':' in 'odoo:19' is a tag, distinguished only by whether
//    a '/' follows. Callers that split on ':' themselves get this wrong, so it
//    is done once, here.
//
// 2. Validation. Every reference reaches Docker through
//    execFile('docker', [...]) — argv, no shell — so a ';' in the string is
//    already inert. It is still rejected, for a reason that outlives the
//    current call sites: argv safety is a property of how TODAY'S code invokes
//    Docker, and the first caller that builds a `docker run ...` string for a
//    log line, a Compose file, or a shell-based debug path inherits whatever
//    got stored. Validating at the boundary means the value in apps.image_ref
//    is safe regardless of who reads it later.
//
// Credentials never appear on argv. There is no username/password parameter on
// any function here and there must not be one: process argv is world-readable
// on Linux (/proc/<pid>/cmdline), so `docker login -p <secret>` leaks the
// secret to every user on the box for the lifetime of the process. Private
// registries authenticate through the daemon's own credential store, which the
// operator sets up out of band.

// Docker's own reference grammar (distribution/reference), transcribed.
//
// A path component is lowercase alphanumeric runs joined by a single '.', a
// single '_', a double '__', or a run of '-'. Uppercase is genuinely invalid in
// a repository path — `docker pull Ubuntu` fails — so rejecting it here matches
// the daemon rather than being stricter than it.
const PATH_COMPONENT_RE = /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*$/;

// A registry host: dot-separated DNS labels with an optional :port. Also
// matches a bare label so 'localhost' and 'localhost:5000' work.
const REGISTRY_RE = /^(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])(?:\.(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]))*(?::\d{1,5})?$/;

// A tag: word char first, then word chars / '.' / '-', 128 max. Docker's limit,
// not an invented one.
const TAG_RE = /^\w[\w.-]{0,127}$/;

// Only sha256 is accepted. Docker's grammar allows other algorithms, but the
// rest of AppCrane records provenance as 'sha256:<hex>' (services/artifactDigest.js,
// isArtifactHash) and a sha512 digest reaching deployments.commit_hash would be
// recognised as an artifact hash while being a length no other code expects.
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

// Long enough for any real registry-qualified digest ref (~200 chars), short
// enough that a pathological string never reaches the regexes above. The path
// component pattern has nested quantifiers, so an unbounded input is a ReDoS
// input.
const MAX_REF_LENGTH = 512;

/**
 * Split an image reference into its parts, or throw.
 *
 * Returns `{registry, name, tag, digest}` where:
 *   registry  the host, or null for an unqualified ref that Docker Hub resolves
 *   name      the repository path WITHOUT the registry ('odoo', 'library/odoo')
 *   tag       the tag as written, or null if none. NOT defaulted to 'latest':
 *             the caller usually wants to know the difference, and a caller
 *             that does not can apply the default itself.
 *   digest    'sha256:<64 hex>', or null
 *
 * Both a tag and a digest may be present ('odoo:19@sha256:...'); Docker ignores
 * the tag in that case and resolves the digest, and so should any caller.
 */
export function parseImageRef(ref) {
  if (typeof ref !== 'string') throw new Error('image reference must be a string');

  const raw = ref.trim();
  if (!raw) throw new Error('image reference is empty');
  if (raw.length > MAX_REF_LENGTH) {
    throw new Error(`image reference is too long (${raw.length} > ${MAX_REF_LENGTH})`);
  }
  // REDUNDANT TODAY, and stated as such rather than dressed up: every regex
  // below is anchored with ^...$ (JS '$' is end-of-input without the m flag, so
  // a trailing newline does not slip past it) and none of their character
  // classes admit a control character, so removing this loop changes no
  // accept/reject decision. Measured, not assumed — it was deleted and the full
  // test file still passed.
  //
  // It stays for the error message. A tab inside a name otherwise surfaces as
  // 'invalid image name component: "od<tab>oo"', which reads as a typo in the
  // name; an operator who pasted a value out of a spreadsheet needs to be told
  // it is whitespace. Written as a code-point scan rather than a character
  // class because a class containing literal control characters is invisible in
  // a diff — this file already had that happen once.
  for (const ch of raw) {
    const code = ch.codePointAt(0);
    if (code <= 0x20 || code === 0x7f) {
      throw new Error('image reference contains whitespace or control characters');
    }
  }

  let rest = raw;
  let digest = null;

  const at = rest.indexOf('@');
  if (at !== -1) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    // A second '@' means this is not a reference — most likely
    // 'user:password@registry/img', i.e. someone trying to put credentials in
    // the string. That must never be stored or handed to Docker.
    if (rest.includes('@')) throw new Error('image reference contains more than one "@"');
    if (!DIGEST_RE.test(digest)) {
      throw new Error(`invalid digest in image reference: expected sha256:<64 hex>, got "${digest}"`);
    }
  }

  let tag = null;
  const lastColon = rest.lastIndexOf(':');
  const lastSlash = rest.lastIndexOf('/');
  // A ':' before the last '/' belongs to a registry port, not a tag. This is
  // the whole reason parsing lives in one place: 'localhost:5000/odoo' has a
  // colon and no tag.
  if (lastColon > lastSlash) {
    tag = rest.slice(lastColon + 1);
    rest = rest.slice(0, lastColon);
    if (!TAG_RE.test(tag)) throw new Error(`invalid tag in image reference: "${tag}"`);
  }

  if (!rest) throw new Error('image reference has no name');

  const parts = rest.split('/');
  let registry = null;
  // Docker's rule verbatim: the first component is a registry only if it looks
  // like a host — contains a '.' or a ':', or is exactly 'localhost'. Without
  // this, 'myorg/myapp' would read as registry 'myorg'.
  if (parts.length > 1 && (parts[0].includes('.') || parts[0].includes(':') || parts[0] === 'localhost')) {
    registry = parts.shift();
    if (!REGISTRY_RE.test(registry)) {
      throw new Error(`invalid registry in image reference: "${registry}"`);
    }
  }

  if (parts.length === 0) throw new Error('image reference has no name');
  for (const part of parts) {
    if (!PATH_COMPONENT_RE.test(part)) {
      throw new Error(
        `invalid image name component: "${part}" ` +
        '(lowercase alphanumerics separated by ".", "_", "__" or "-")',
      );
    }
  }

  return { registry, name: parts.join('/'), tag, digest };
}

// A pull of a large image over a slow link is legitimately slow, so this is
// generous — but it is finite, because a registry that accepts the connection
// and then stalls would otherwise hang the deploy forever with no log line
// explaining why.
const PULL_TIMEOUT_MS = 15 * 60 * 1000;
const INSPECT_TIMEOUT_MS = 60 * 1000;

/**
 * `docker pull <ref>`.
 *
 * The reference is validated first and passed as a single argv element — never
 * interpolated into a shell string. Resolves when the pull completes; rejects
 * with Docker's own stderr, which is the only place the real reason (auth
 * required, manifest unknown, no such host) is stated.
 */
export async function pullImage(ref) {
  const parsed = parseImageRef(ref);
  const canonical = ref.trim();

  try {
    await execFileAsync('docker', ['pull', canonical], {
      timeout: PULL_TIMEOUT_MS,
      // A pull's progress output is unbounded in principle; a few MB is far
      // more than the final summary needs and stops a hostile registry from
      // growing the buffer without limit.
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (err) {
    const detail = (err.stderr || err.message || '').trim();
    throw new Error(`docker pull ${parsed.name} failed: ${detail}`);
  }
}

/**
 * The immutable identity of an image that is already local.
 *
 * A tag is a pointer — 'odoo:19' means something different after the publisher
 * pushes a patch — so recording the tag against a deployment records nothing
 * checkable. RepoDigests holds the registry-side content digest, which is what
 * actually pins the bytes, and is what deployments.image_ref and
 * deployments.commit_hash are for.
 *
 * Returns 'sha256:<64 hex>' — the same shape services/artifactDigest.js
 * produces, so isArtifactHash() recognises an image deploy as having real
 * provenance rather than falling back to the 'unknown' commit path.
 *
 * Throws when the image has no RepoDigests. That is not a corner case to paper
 * over: an image built locally and never pushed has an empty RepoDigests, and
 * the plausible-looking fallbacks are both wrong — .Id is the local config
 * digest, which is NOT the registry digest and cannot be pulled by anyone else,
 * and returning the tag pretends a moving pointer is a pin.
 */
export async function resolveDigest(ref) {
  parseImageRef(ref);
  const canonical = ref.trim();

  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      'docker',
      ['image', 'inspect', canonical, '--format', '{{index .RepoDigests 0}}'],
      { timeout: INSPECT_TIMEOUT_MS },
    ));
  } catch (err) {
    const detail = (err.stderr || err.message || '').trim();
    // The template indexes element 0 of a slice that is empty for a
    // never-pushed image, and Go's `index` reports that as a range error. It is
    // the expected outcome for a real situation, not a malformed command, so it
    // gets its own message instead of Docker's template diagnostic.
    if (/index out of range/i.test(detail)) {
      throw new Error(
        `image ${canonical} has no RepoDigests — it exists locally but was never pulled from ` +
        'or pushed to a registry, so there is no digest to pin the deployment to',
      );
    }
    throw new Error(`docker image inspect ${canonical} failed: ${detail}`);
  }

  const out = (stdout || '').trim();
  // Belt and braces for the same empty-RepoDigests case: some Docker versions
  // render a missing value as the literal '<no value>' with exit code 0 rather
  // than failing the template, which would otherwise return that string as if
  // it were a digest.
  if (!out || out === '<no value>') {
    throw new Error(
      `image ${canonical} has no RepoDigests — it exists locally but was never pulled from ` +
      'or pushed to a registry, so there is no digest to pin the deployment to',
    );
  }

  // RepoDigests entries are 'name@sha256:<hex>'. Only the digest is wanted; the
  // name half is the repository the digest was observed in, which the caller
  // already knows.
  const at = out.lastIndexOf('@');
  const digest = at === -1 ? out : out.slice(at + 1);
  if (!DIGEST_RE.test(digest)) {
    throw new Error(`docker returned an unrecognised RepoDigest for ${canonical}: "${out}"`);
  }
  return digest;
}

export default { parseImageRef, pullImage, resolveDigest };
