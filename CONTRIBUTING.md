# Contributing to KaiSign MCP Server

Thank you for your interest in contributing! This guide will help you get started.

## Getting Started

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/your-username/MCP.git
   cd MCP
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Create a branch for your changes:
   ```bash
   git checkout -b feature/your-feature-name
   ```

## Development Setup

### Prerequisites

- Node.js >= 18.0.0
- npm

### Environment

Copy the example environment file:

```bash
cp .env.example .env
```

Fill in your API keys (see `.env.example` for descriptions).

### Running in Development

```bash
npm run dev
```

### Running Tests

```bash
# Run all tests
npm test

# Run tests once (no watch mode)
npm run test:run

```

## Making Changes

### Code Style

- Write TypeScript with strict types
- Use ESM imports (`import/export`, not `require`)
- Keep functions focused and well-named
- Add JSDoc comments for public APIs

### Project Structure

- `src/services/` — Core business logic (verification, decoding, caching)
- `src/tools/` — MCP tool definitions (thin wrappers around services)
- `src/config/` — Configuration and constants
- `tests/` — Test files using Vitest

### Adding a New MCP Tool

1. Create the tool handler in `src/tools/`
2. Define the Zod schema for input validation
3. Register the tool in `src/index.ts` (add to `tools` array and `switch` handler)
4. Add tests in `tests/`

### Adding Chain Support

1. Add the RPC URL to `src/config/constants.ts` in the `RPC_URLS` map
2. Add the chain to the `SUPPORTED_CHAINS` array
3. Update environment variable handling if needed

## Submitting Changes

### Pull Request Process

1. Ensure all tests pass: `npm run test:run`
2. Build successfully: `npm run build`
3. Write a clear PR description explaining:
   - What changed and why
   - How to test the changes
   - Any breaking changes
4. Link any related issues

### Commit Messages

Use clear, descriptive commit messages:

```
feat: add support for Polygon chain
fix: handle proxy contracts with empty bytecode
docs: update deployment guide for Base
test: add verification tests for USDC contract
```

Prefixes: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`

## Reporting Issues

- Use GitHub Issues for bug reports and feature requests
- Include steps to reproduce for bugs
- For security vulnerabilities, see [SECURITY.md](SECURITY.md)

## Code of Conduct

Please read and follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
