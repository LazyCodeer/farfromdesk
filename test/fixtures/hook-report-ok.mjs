// Stands in for `cli.js install-hooks --json`. Test only.
process.stdout.write(JSON.stringify([{ provider: 'codex', file: '/tmp/hooks.json', state: 'current' }]) + '\n');
