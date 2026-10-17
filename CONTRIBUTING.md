# Contributing to openBIMstudio

Thank you for considering contributing to openBIMstudio!

## Where to Start

1. Run the project locally - see [README](./README.md#getting-started).
2. Read [docs/INSTALL_AND_UX.md](./docs/INSTALL_AND_UX.md).
3. Pick a task from the gap analyses in docs/.

## Development Workflow

```bash
git clone https://github.com/YOUR_USERNAME/openBIMstudio.git
cd openBIMstudio
npm install
git checkout -b feature/your-feature-name
npm run typecheck
node tests/run-tests.mjs
git push origin feature/your-feature-name
```

Open a pull request against main. Describe what and why. Link the gap you are addressing.

## Coding Guidelines

- TypeScript, modular architecture
- Never hard-crash the app - use safe() wrappers
- New logic should come with tests
- Update the relevant doc when adding features

## Reporting Bugs

Open an issue with title, reproduction steps, and browser console output (look for [critical-gaps-boot]).

## Code of Conduct

See [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).