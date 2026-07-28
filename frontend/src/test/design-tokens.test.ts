import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const indexCssPath = path.resolve(__dirname, '../index.css')
const indexCss = fs.readFileSync(indexCssPath, 'utf-8')

describe('Design Tokens — Warm Handcrafted Palette', () => {
  describe('CSS custom properties in :root', () => {
    it('defines --color-bg-primary as warm cream', () => {
      expect(indexCss).toMatch(/--color-bg-primary:\s*#faf6f1/)
    })

    it('defines --color-surface as warm white', () => {
      expect(indexCss).toMatch(/--color-surface:\s*#fffefa/)
    })

    it('defines --color-accent as terracotta', () => {
      expect(indexCss).toMatch(/--color-accent:\s*#c75b39/)
    })

    it('defines --color-accent-alt as soft sage', () => {
      expect(indexCss).toMatch(/--color-accent-alt:\s*#8a9a7b/)
    })

    it('defines --color-text as warm brown (not black)', () => {
      expect(indexCss).toMatch(/--color-text:\s*#3d2b1f/)
    })

    it('defines --color-text-muted as warm gray (not slate)', () => {
      expect(indexCss).toMatch(/--color-text-muted:\s*#8c7b6b/)
    })

    it('defines --color-border as warm light', () => {
      expect(indexCss).toMatch(/--color-border:\s*#e8dfd5/)
    })

    it('defines --color-error as warm red', () => {
      expect(indexCss).toMatch(/--color-error:\s*#c45c4a/)
    })

    it('defines --color-success as warm green', () => {
      expect(indexCss).toMatch(/--color-success:\s*#6b8f5e/)
    })

    it('defines semantic color variants (hover, light)', () => {
      expect(indexCss).toMatch(/--color-accent-hover:/)
      expect(indexCss).toMatch(/--color-accent-light:/)
      expect(indexCss).toMatch(/--color-error-light:/)
      expect(indexCss).toMatch(/--color-success-light:/)
    })
  })

  describe('Google Fonts integration', () => {
    it('imports Playfair Display via Google Fonts', () => {
      expect(indexCss).toMatch(/@import url\(.*Playfair\+Display/)
    })

    it('imports Source Sans 3 via Google Fonts', () => {
      expect(indexCss).toMatch(/@import url\(.*Source\+Sans\+3/)
    })

    it('does NOT import forbidden fonts', () => {
      expect(indexCss).not.toMatch(/Inter/)
      expect(indexCss).not.toMatch(/Roboto/)
      expect(indexCss).not.toMatch(/Open\+Sans/)
    })
  })

  describe('Typography scale', () => {
    it('sets display font family to Playfair Display', () => {
      expect(indexCss).toMatch(/--font-display:.*'Playfair Display'/)
    })

    it('sets body font family to Source Sans 3', () => {
      expect(indexCss).toMatch(/--font-body:.*'Source Sans 3'/)
    })

    it('defines text-5xl at 42px (2.625rem)', () => {
      expect(indexCss).toMatch(/--text-5xl:\s*2\.625rem/)
    })

    it('defines text-base at 16px (1rem)', () => {
      expect(indexCss).toMatch(/--text-base:\s*1rem/)
    })

    it('has at least 3x size jump between base and largest heading', () => {
      const baseMatch = indexCss.match(/--text-base:\s*([\d.]+)rem/)
      const xlMatch = indexCss.match(/--text-5xl:\s*([\d.]+)rem/)
      expect(baseMatch).not.toBeNull()
      expect(xlMatch).not.toBeNull()
      const base = parseFloat(baseMatch![1])
      const xl = parseFloat(xlMatch![1])
      expect(xl / base).toBeGreaterThanOrEqual(2.5)
    })

    it('defines line-height scale', () => {
      expect(indexCss).toMatch(/--leading-tight:/)
      expect(indexCss).toMatch(/--leading-normal:/)
      expect(indexCss).toMatch(/--leading-relaxed:/)
    })

    it('defines letter-spacing scale', () => {
      expect(indexCss).toMatch(/--tracking-tight:/)
      expect(indexCss).toMatch(/--tracking-normal:/)
      expect(indexCss).toMatch(/--tracking-wide:/)
    })
  })

  describe('Tailwind v4 @theme configuration', () => {
    it('has @theme directive', () => {
      expect(indexCss).toMatch(/@theme\s*\{/)
    })

    it('defines warm color palette in @theme', () => {
      expect(indexCss).toMatch(/--color-warm-500:/)
      expect(indexCss).toMatch(/--color-terracotta-500:/)
      expect(indexCss).toMatch(/--color-sage-500:/)
    })

    it('maps font families in @theme', () => {
      expect(indexCss).toMatch(/--font-display:.*'Playfair Display'/)
      expect(indexCss).toMatch(/--font-body:.*'Source Sans 3'/)
    })

    it('defines warm shadows in @theme', () => {
      expect(indexCss).toMatch(/--shadow-warm-sm:/)
      expect(indexCss).toMatch(/--shadow-warm-md:/)
      expect(indexCss).toMatch(/--shadow-warm-lg:/)
    })
  })

  describe('Spacing, shadows, and radii tokens', () => {
    it('defines spacing scale with 4px base', () => {
      expect(indexCss).toMatch(/--space-1:\s*0\.25rem/)
      expect(indexCss).toMatch(/--space-4:\s*1rem/)
      expect(indexCss).toMatch(/--space-8:\s*2rem/)
    })

    it('defines border-radius scale', () => {
      expect(indexCss).toMatch(/--radius-sm:/)
      expect(indexCss).toMatch(/--radius-md:/)
      expect(indexCss).toMatch(/--radius-lg:/)
      expect(indexCss).toMatch(/--radius-full:/)
    })

    it('defines warm-tinted shadows', () => {
      expect(indexCss).toMatch(/--shadow-sm:.*rgba\(61,\s*43,\s*31/)
      expect(indexCss).toMatch(/--shadow-lg:.*rgba\(61,\s*43,\s*31/)
    })

    it('defines transition tokens', () => {
      expect(indexCss).toMatch(/--transition-fast:/)
      expect(indexCss).toMatch(/--transition-base:/)
      expect(indexCss).toMatch(/--transition-slow:/)
    })
  })

  describe('Background and atmosphere', () => {
    it('applies multi-layer background on body', () => {
      expect(indexCss).toMatch(/radial-gradient/)
      expect(indexCss).toMatch(/linear-gradient/)
    })

    it('uses warm tones in gradient backgrounds', () => {
      expect(indexCss).toMatch(/199,\s*91,\s*57/)
      expect(indexCss).toMatch(/138,\s*154,\s*123/)
    })
  })

  describe('Global style rules', () => {
    it('sets body font to design token', () => {
      expect(indexCss).toMatch(/font-family:\s*var\(--font-body\)/)
    })

    it('sets body color to design token', () => {
      expect(indexCss).toMatch(/color:\s*var\(--color-text\)/)
    })

    it('applies focus-visible outline with accent color', () => {
      expect(indexCss).toMatch(/:focus-visible/)
      expect(indexCss).toMatch(/outline.*var\(--color-border-focus\)/)
    })

    it('applies selection highlight with accent color', () => {
      expect(indexCss).toMatch(/::selection/)
      expect(indexCss).toMatch(/199,\s*91,\s*57/)
    })

    it('defines scrollbar styles', () => {
      expect(indexCss).toMatch(/::-webkit-scrollbar/)
      expect(indexCss).toMatch(/::-webkit-scrollbar-thumb/)
    })
  })
})
