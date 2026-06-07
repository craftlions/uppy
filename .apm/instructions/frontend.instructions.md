---
description: Conventions for Astro frontend files (Tailwind v4, SSR on Cloudflare)
applyTo: "**/*.astro"
---

- Style with inline Tailwind v4 utility classes only; do not add `<style>` blocks or author custom CSS. The single stylesheet is `src/styles/global.css`, which only imports Tailwind.
- Default to CSS grid (`grid`) for layout; reach for flexbox only for genuinely one-dimensional arrangements.
- Keep markup minimal and semantic - choose the meaningful HTML element (`<main>`, `<nav>`, `<header>`, `<button>`, and so on) over generic `<div>`/`<span>`.
- Cover accessibility basics: descriptive `alt` text, labelled form controls, and a `lang` attribute on `<html>`.
- Extract repeated markup into reusable `.astro` components under `src/components`, and compose them instead of duplicating markup.
- Keep `src/pages` files thin - layout composition and data wiring, not large inline markup blocks.
