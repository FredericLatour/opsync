# Security

Report vulnerabilities privately through this repository's GitHub **Security →
Report a vulnerability** feature once enabled by the maintainer. If unavailable,
ask the maintainer for a private reporting channel without posting the exploit
or credentials in a public issue. Do not include database dumps or n8n exports.

Use a dedicated database account with only the permissions required for the
operation. Keep TOML configuration readable only by the operating account.
Database passwords are supplied to client processes through their environment;
users with sufficient process/container inspection permissions can still read
them. Docker access itself is privileged. Treat restore inputs as executable SQL
or n8n content and restore only trusted backups.

Backups are created atomically with mode 0600 on POSIX filesystems. S3 access,
transport security, encryption at rest and lifecycle rules are configured by the
operator. Decrypted n8n exports contain live credentials. Encrypted exports also
require the separately protected instance encryption key.

Review source and configuration before sharing them. When publishing a repository,
enable secret scanning and push protection where available. Only the latest
published release receives fixes.
