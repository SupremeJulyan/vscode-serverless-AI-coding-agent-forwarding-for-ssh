# Third-party notices

SAFS adapts SSH session ownership, authentication flow, SFTP handle lifecycle,
and sudo prompt middleware from [Eugeny/tabby](https://github.com/Eugeny/tabby),
commit `467ce8ebfa467fb88cf6d154c9a5891e3d3647f0`:

- `tabby-ssh/src/session/{ssh,shell,sftp}.ts`
- `tabby-ssh/src/services/sshMultiplexer.service.ts`
- `tabby-auto-sudo-password/src/decorator.ts`

Copyright (c) 2017 Tabby Developers. MIT license, reproduced in
[third-party/Tabby-MIT.txt](third-party/Tabby-MIT.txt).
SAFS adaptations replace Angular/Tabby services with VS Code APIs, implement
connection leases and stream adapters, and add incremental sudo prompt parsing.

The SSH and SFTP client is [`ssh2`](https://github.com/mscdex/ssh2) 1.17.0 (MIT).
Its upstream license is reproduced in [third-party/ssh2-MIT.txt](third-party/ssh2-MIT.txt).
`shell-quote` (MIT) is bundled with the extension; its license is in `third-party/`.
