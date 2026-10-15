# Security policy

Private Tools processes files that may be hostile. Parsers treat every input as untrusted, and pages run under a Content Security Policy that blocks network requests.

## Reporting a vulnerability

Report security issues privately through [GitHub private vulnerability reporting](https://github.com/rivera-daniel/private-tools/security/advisories/new). Do not open a public issue.

Useful reports include:

- a file that makes a page send data over the network, run script or render extracted values as HTML
- a file that makes the cleaner produce output that still contains the metadata it reported as removed
- a file that hangs or crashes a parser beyond the stated size and time limits

Include the file, or a way to generate it, and the browser and version. Reports are acknowledged within a week.

## Scope

The code in this repository and the pages served from danielrivera.ai/tools/. Third-party services in front of the site, such as Cloudflare, are out of scope.
