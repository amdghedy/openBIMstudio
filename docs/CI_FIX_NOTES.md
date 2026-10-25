# CI fix notes (2026-10-25)

## Root cause of Action failures

`package.json` had mixed React versions:

- `react`: ^18.3.1
- `react-dom`: ^19.3.1
- `@types/react`: ^18.3.0
- `@types/react-dom`: ^19.3.0

That breaks `npm run typecheck` and unit-test workflows.

## Fixed on main

- `package.json` aligned all four packages to **React 18.3.x**.

## Still required locally / in CI lockfile

If `npm ci` still installs `react-dom@19`, regenerate the lockfile:

```bash
npm install react@18.3.1 react-dom@18.3.1 @types/react@18.3.12 @types/react-dom@18.3.1
npm ci
npm run typecheck
```

Then commit `package-lock.json`.

## Dependabot PRs #53–#57

These are **major** bumps (React 19, R3F 9, MUI lab dev, etc.) and will keep failing CI until a dedicated migration is done. Close or leave open with REQUEST_CHANGES; do not merge into main.
