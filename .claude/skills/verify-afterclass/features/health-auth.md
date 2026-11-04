# Health and auth

## Sub-features

- `/health` needs Host and Origin only. Every other route needs a bearer token too.

## How to get to it (user POV)

Not user-facing; it protects Derek's data from web pages and other origins.

## Driving it with call.sh and curl

1. `doctor.sh "$WORK"` prints OK.
2. `curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.test' http://127.0.0.1:$PORT/health` expects 403.
3. `curl -s -o /dev/null -w '%{http_code}' -H 'Origin: https://evil.test' http://127.0.0.1:$PORT/health` expects 403.
4. `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/usage` expects 401.

## Gotchas

- 403 (Host or Origin) is reported before 401 (token).
