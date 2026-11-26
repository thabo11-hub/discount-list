#!/usr/bin/env python3
"""Scan a git repo's whole history (every branch) for leaked secrets. Prints masked hits only.
Exits 1 on a high-confidence secret or sensitive file. After rotating a leaked key, add its
fingerprint (sha256:...) on its own line to .github/secret-scan-ignore.
Usage: secret_scan.py [REPO_DIR ...]"""
import hashlib, re, subprocess, sys
from pathlib import Path

HIGH = [
    ("AWS access key", r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
    ("Private key", r"-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----"),
    ("GitHub token", r"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})"),
    ("Stripe/Paystack key", r"\b(?:sk|rk)_live_[A-Za-z0-9]{16,}"),
    ("Stripe webhook secret", r"\bwhsec_[A-Za-z0-9]{24,}"),
    ("AI provider key", r"\bsk-(?:ant-[a-z0-9]+-|proj-)[A-Za-z0-9_-]{24,}"),
    ("Google API key", r"\bAIza[0-9A-Za-z_-]{35}"),
    ("Slack token", r"\bxox[abprs]-[A-Za-z0-9-]{10,}"),
    ("SendGrid key", r"\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}"),
    ("Resend key", r"\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}"),
    ("JWT (e.g. Supabase service key)", r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),
    ("Supabase secret key", r"\bsb_secret_[A-Za-z0-9_-]{16,}"),
    ("Database URL with password",
     r"\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?|libsql)://[^:\s/'\"@]+:[^@\s'\"]{6,}@[^\s'\"<>]+"),
]
LOW = [("Secret-looking assignment",
        r"(?i)\b[A-Z0-9_]*(?:password|passwd|secret|api_?key|access_?key|private_?key|auth_?token)[A-Z0-9_]*"
        r"\s*[:=]\s*['\"]([^'\"\s]{12,})['\"]")]
RISKY = re.compile(r"(^|/)(\.env(\.[^/]*)?|[^/]*\.(pem|key|p12|pfx|jks|keystore)|id_(rsa|ed25519|ecdsa)[^/]*|"
                   r"[^/]*credentials?[^/]*\.json|[^/]*service[-_]?account[^/]*\.json|\.npmrc|\.pypirc|"
                   r"[^/]*\.(sqlite3?|db)|[^/]*dump[^/]*\.sql)$", re.I)
SAFE = re.compile(r"(^|/)\.env\.(example|sample|template)$|(^|/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$", re.I)
TESTS = re.compile(r"(^|/)(tests?|__tests__|spec|fixtures?|mocks?)/|\.(test|spec)\.[a-z]+$", re.I)
PLACEHOLDER = re.compile(r"(?i)(x{4,}|\*{4,}|your[-_]|change[-_]?me|example|placeholder|dummy|redacted|sample|"
                         r"not[-_]a[-_]real|fake|test|\$\{|process\.env|<[a-z_]+>)")
REGEXISH = re.compile(r"[\[\](){}\\^$|?+]")

def git(repo, *a):
    return subprocess.run(["git", "-C", repo, *a], capture_output=True, text=True, errors="replace", check=True).stdout

def fp(v):
    return "sha256:" + hashlib.sha256(v.encode()).hexdigest()[:16]

def scan(repo):
    ig = Path(repo, ".github", "secret-scan-ignore")
    ignored = set(ig.read_text().split()) if ig.exists() else set()
    hits, commit, path = {}, "", ""
    for line in git(repo, "log", "-p", "--all", "--no-color", "--no-ext-diff", "--format=commit %h %ad", "--date=short").splitlines():
        if line.startswith("commit "):
            commit = " ".join(line.split()[1:3])
        elif line.startswith("+++ "):
            path = line[6:] if line.startswith("+++ b/") else line[4:]
        elif line.startswith("+") and not line.startswith("+++") and not SAFE.search(path):
            for level, pats in (("high", HIGH), ("low", LOW)):
                if level == "low" and TESTS.search(path):
                    continue
                for name, rx in pats:
                    for m in re.finditer(rx, line):
                        v = m.group(1) if m.groups() else m.group(0)
                        if level == "low" and (PLACEHOLDER.search(v) or REGEXISH.search(v)):
                            continue
                        if fp(v) not in ignored:
                            hits.setdefault((name, fp(v)), dict(name=name, level=level, file=path, first=commit, v=v))
    tracked = set(git(repo, "ls-files").splitlines())
    added = git(repo, "log", "--all", "--diff-filter=A", "--name-only", "--format=").splitlines()
    risky = sorted({p for p in added if p and RISKY.search(p) and not SAFE.search(p) and fp("file:" + p) not in ignored})
    print(f"# Secret scan: {repo}")
    failed = False
    for h in sorted(hits.values(), key=lambda h: (h["level"] != "high", h["file"])):
        failed |= h["level"] == "high"
        f = Path(repo, h["file"])
        here = h["file"] in tracked and f.is_file() and h["v"] in f.read_text(errors="replace")
        print(f"- [{'LEAK' if h['level'] == 'high' else 'check'}] {h['name']}: {h['v'][:4]}... ({len(h['v'])} chars) in {h['file']} "
              f"(first added {h['first']}; {'still in the code' if here else 'in history only'}) {fp(h['v'])}")
    for p in risky:
        failed = True
        print(f"- [LEAK] Sensitive file committed: {p} ({'still tracked' if p in tracked else 'deleted, still in history'}) {fp('file:' + p)}")
    if not hits and not risky:
        print("No likely secrets in any commit on any branch.")
    return failed

if __name__ == "__main__":
    bad = False
    for r in sys.argv[1:] or ["."]:
        bad |= scan(r)
    if bad:
        print("Rotate the leaked key at its provider first, then add its fingerprint to .github/secret-scan-ignore.")
    sys.exit(1 if bad else 0)
