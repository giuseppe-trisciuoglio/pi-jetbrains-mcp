# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-07-27

### Added

- Per-project endpoint selection via a `.pi/jetbrains.json` file at the project root: a whitelist of endpoint ids. Missing file falls back to all endpoints; an empty list activates none.
- `/jetbrains use <id>`, `/jetbrains unuse <id>`, and `/jetbrains selection` commands to manage the per-project selection.

## [Unreleased]

## [1.0.0] - 2026-07-25

### Added

- Multi-endpoint JetBrains IDE MCP Server integration for pi.
- Dynamic registration of MCP tools with stable endpoint prefixes.
- Runtime commands for checking endpoint status, reconnecting, and changing endpoint URLs.
- Configuration migration from the former single-endpoint format.
- npm package metadata, GitHub Actions CI, and trusted npm publishing workflow.

[Unreleased]: https://github.com/giuseppe-trisciuoglio/pi-jetbrains-mcp/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/giuseppe-trisciuoglio/pi-jetbrains-mcp/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/giuseppe-trisciuoglio/pi-jetbrains-mcp/releases/tag/v1.0.0
