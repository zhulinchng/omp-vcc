# @zhu/omp-vcc

## Capabilities

- extension
- skill
- command

## Develop

```bash
omp plugin link .
omp plugin doctor
bun run smoke.ts  # or bun run scripts/smoke.ts
bun test
```

## Publish

- npm: `npm publish` then `omp plugin install @zhu/omp-vcc`
- Marketplace: add an entry to `.omp-plugin/marketplace.json` (see `plugin-skill/assets/templates/marketplace-entry.json.template`).