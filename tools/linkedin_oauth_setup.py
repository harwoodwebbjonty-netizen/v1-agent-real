#!/usr/bin/env python3
"""One-time OAuth setup: exchanges a LinkedIn Developer App's client
credentials for a member access token and saves it to .env.

Before running this, in the LinkedIn Developer Portal
(https://www.linkedin.com/developers/apps):

1. Create an app. It must be linked to a LinkedIn Page you administer —
   create a minimal placeholder Page first if you don't have one.
2. On the app's "Products" tab, request "Share on LinkedIn" and
   "Sign In with LinkedIn using OpenID Connect" (both self-serve, no
   partner approval needed).
3. On the app's "Auth" tab, add this exact redirect URL:
   http://localhost:8765/callback
4. Copy the Client ID and Client Secret into .env:
   LINKEDIN_CLIENT_ID=...
   LINKEDIN_CLIENT_SECRET=...
5. Run: python3 tools/linkedin_oauth_setup.py

The resulting access token expires after ~60 days (LinkedIn doesn't grant
refresh tokens on the default app tier) — rerun this script when
tools/post_to_linkedin.py starts failing with a 401.
"""
import json
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer

from linkedin_env import load_env, set_env

REDIRECT_URI = "http://localhost:8765/callback"
SCOPES = "openid profile w_member_social"

_result = {}


class CallbackHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        _result["code"] = params.get("code", [None])[0]
        _result["state"] = params.get("state", [None])[0]
        _result["error"] = params.get("error_description", [None])[0]
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        msg = (
            "Authorized — you can close this tab and return to the terminal."
            if _result["code"]
            else f"Error: {_result['error']}"
        )
        self.wfile.write(msg.encode())

    def log_message(self, *args):
        pass


def main():
    env = load_env()
    client_id = env.get("LINKEDIN_CLIENT_ID")
    client_secret = env.get("LINKEDIN_CLIENT_SECRET")
    if not client_id or not client_secret:
        sys.exit(
            "Missing LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET in .env — "
            "see the setup steps in this file's docstring."
        )

    state = secrets.token_urlsafe(16)
    auth_url = "https://www.linkedin.com/oauth/v2/authorization?" + urllib.parse.urlencode({
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": REDIRECT_URI,
        "scope": SCOPES,
        "state": state,
    })

    server = HTTPServer(("localhost", 8765), CallbackHandler)
    server.timeout = 120

    print("Opening browser for LinkedIn authorization...")
    print(auth_url)
    webbrowser.open(auth_url)
    server.handle_request()

    if not _result.get("code"):
        sys.exit(f"Authorization failed or timed out: {_result.get('error', 'no response received')}")
    if _result.get("state") != state:
        sys.exit("State mismatch — possible CSRF, aborting.")

    try:
        token_resp = urllib.request.urlopen(urllib.request.Request(
            "https://www.linkedin.com/oauth/v2/accessToken",
            data=urllib.parse.urlencode({
                "grant_type": "authorization_code",
                "code": _result["code"],
                "redirect_uri": REDIRECT_URI,
                "client_id": client_id,
                "client_secret": client_secret,
            }).encode(),
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        ))
    except urllib.error.HTTPError as e:
        sys.exit(f"Token exchange failed: {e.code} {e.read().decode()}")

    token_data = json.loads(token_resp.read())
    access_token = token_data["access_token"]

    userinfo_resp = urllib.request.urlopen(urllib.request.Request(
        "https://api.linkedin.com/v2/userinfo",
        headers={"Authorization": f"Bearer {access_token}"},
    ))
    person_id = json.loads(userinfo_resp.read())["sub"]

    set_env({
        "LINKEDIN_ACCESS_TOKEN": access_token,
        "LINKEDIN_PERSON_URN": f"urn:li:person:{person_id}",
    })
    days = token_data.get("expires_in", 0) // 86400
    print(f"Saved access token and person URN (urn:li:person:{person_id}) to .env.")
    print(f"Token expires in ~{days} days — rerun this script when it expires.")


if __name__ == "__main__":
    main()
