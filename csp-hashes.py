#!/usr/bin/env python3
"""Recompute the Content-Security-Policy hashes in each page.

Both dashboards keep their logic and their page-specific CSS inline, which is
the right call for static files on GitHub Pages with no build step. The cost is
that a policy allowing them has to say so, and the blunt way to say it is
'unsafe-inline' - which also allows any script or style an attacker manages to
inject, and so gives away most of what a CSP is for.

A hash is the precise way to say it instead: the policy names the exact bytes
it trusts, and anything else is refused. The catch is that the hash changes
whenever the block does, so run this after editing any inline <script> or
<style> and commit the result:

    python3 csp-hashes.py            # rewrite the pages in place
    python3 csp-hashes.py --check    # verify only, non-zero exit if stale

The --check mode is what to wire into CI, if there ever is any. It is also
worth running before a deploy: a stale hash does not degrade, it blocks the
script outright and the page comes up blank.
"""

import base64
import hashlib
import pathlib
import re
import sys

PAGES = ['index.html', 'pr-tracker.html', 'branch-compare.html']

BLOCK_RE = re.compile(r'<(script|style)(?![^>]*\bsrc=)([^>]*)>(.*?)</\1>', re.S)
CSP_RE = re.compile(r'(<meta http-equiv="Content-Security-Policy" content=")([^"]*)(")')


def sha256_source(text: str) -> str:
    """CSP hashes cover the element's exact text content, UTF-8 encoded."""
    digest = hashlib.sha256(text.encode('utf-8')).digest()
    return "'sha256-" + base64.b64encode(digest).decode('ascii') + "'"


def directive_with(policy: str, name: str, sources: list) -> str:
    """Replace one directive's source list with a freshly computed one.

    Both filters matter. Dropping 'unsafe-inline' is the point of the exercise.
    Dropping any existing 'sha256-...' is what makes this idempotent: without
    it, every run appends the hashes again and --check can never agree with
    itself.
    """
    parts = [p.strip() for p in policy.split(';') if p.strip()]
    out = []
    for part in parts:
        if part.split()[0] == name:
            keep = [s for s in part.split()[1:]
                    if s != "'unsafe-inline'" and not s.startswith("'sha256-")]
            out.append(' '.join([name] + keep + sources))
        else:
            out.append(part)
    return '; '.join(out)


def process(path: pathlib.Path, check: bool) -> bool:
    src = path.read_text(encoding='utf-8')
    csp = CSP_RE.search(src)
    if not csp:
        print(f'{path}: no CSP meta tag, skipped')
        return True

    hashes = {'script': [], 'style': []}
    for kind, _attrs, body in BLOCK_RE.findall(src):
        hashes[kind].append(sha256_source(body))

    policy = csp.group(2)
    for kind, name in (('script', 'script-src'), ('style', 'style-src')):
        if hashes[kind] and name in policy:
            policy = directive_with(policy, name, hashes[kind])

    updated = src[:csp.start()] + csp.group(1) + policy + csp.group(3) + src[csp.end():]
    if updated == src:
        print(f'{path}: up to date')
        return True
    if check:
        print(f'{path}: STALE - run csp-hashes.py to fix')
        return False
    path.write_text(updated, encoding='utf-8')
    n = len(hashes['script']) + len(hashes['style'])
    print(f'{path}: updated ({n} hash{"" if n == 1 else "es"})')
    return True


def main() -> int:
    check = '--check' in sys.argv
    here = pathlib.Path(__file__).parent
    # A list, not a generator: every page gets reported, so one stale file
    # does not hide the next.
    results = [process(here / p, check) for p in PAGES if (here / p).exists()]
    return 0 if all(results) else 1


if __name__ == '__main__':
    sys.exit(main())
