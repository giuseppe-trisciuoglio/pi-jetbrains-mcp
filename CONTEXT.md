# Context

Glossary for the JetBrains MCP bridge extension domain.

## Endpoint

A configured connection to the MCP Server of a JetBrains IDE (PhpStorm, IntelliJ IDEA, WebStorm, …), identified by a stable `id` and a URL. Endpoints are defined once, in the global configuration. Each endpoint exposes a set of tools that get registered with an `<id>__` prefix.

## Project selection

The set of endpoints a given project declares it wants to use, via a `.pi/jetbrains.json` file at the project root containing a whitelist of ids. The selection defines the visible perimeter for the whole session: only selected endpoints are connected and have their tools registered.

## Fallback

The behavior when the selection file does not exist: all globally configured endpoints are used. Distinct from the case "file present with an empty list", which deliberately means no endpoint for that project.
