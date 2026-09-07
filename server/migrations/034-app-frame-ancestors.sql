-- Per-app CSP frame-ancestors — controls who's allowed to iframe an app.
-- NULL means "default" (kept locked to 'self' via the global X-Frame-Options
-- header). A populated value emits a per-app `Content-Security-Policy:
-- frame-ancestors <value>` header in Caddy and overrides the global
-- X-Frame-Options on AppCrane-served pages (/login, etc.) when a redirect
-- targets that app's slug.
--
-- Value must be a valid CSP source list, e.g. "'self' https://my.example.com"
-- — input is regex-validated server-side before being written.
ALTER TABLE apps ADD COLUMN frame_ancestors TEXT;
