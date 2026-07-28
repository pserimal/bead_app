import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const appCssPath = path.resolve(__dirname, '../App.css')
const appCss = fs.readFileSync(appCssPath, 'utf-8')

describe('App.css cleanup', () => {
  it('removes Vite template .counter selector', () => {
    expect(appCss).not.toMatch(/\.counter\b/)
  })

  it('removes Vite template .hero selector', () => {
    expect(appCss).not.toMatch(/\.hero\b/)
  })

  it('removes Vite template #center selector', () => {
    expect(appCss).not.toMatch(/#center\b/)
  })

  it('removes Vite template #next-steps selector', () => {
    expect(appCss).not.toMatch(/#next-steps\b/)
  })

  it('removes Vite template #docs selector', () => {
    expect(appCss).not.toMatch(/#docs\b/)
  })

  it('adds html scroll-behavior: smooth', () => {
    expect(appCss).toMatch(/scroll-behavior:\s*smooth/)
  })

  it('adds :focus-visible outline styles', () => {
    expect(appCss).toMatch(/\*:focus-visible\b/)
    expect(appCss).toMatch(/outline:\s*2px\s+solid\s+var\(--color-accent\)/)
  })

  it('adds ::selection styles', () => {
    expect(appCss).toMatch(/::selection/)
    expect(appCss).toMatch(/background:\s*var\(--color-accent\)/)
  })

  it('adds scrollbar styles', () => {
    expect(appCss).toMatch(/::-webkit-scrollbar\b/)
    expect(appCss).toMatch(/::-webkit-scrollbar-thumb\b/)
  })
})
