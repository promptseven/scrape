// app.js
import express from 'express'
import bodyParser from 'body-parser'
import puppeteer from 'puppeteer-core'

const app = express()
app.use(bodyParser.json({ limit: '10mb' }))

const DEFAULTS = {
  maxScrolls: 20,
  scrollDelayMs: 2000,
  headless: true,
  viewport: { width: 1200, height: 900 },
  baseTimeoutMs: 10000,
}

const BROWSERLESS_WS =
  process.env.BROWSERLESS_WS || 'ws://browserless:3000?ws=true'

app.post('/scrape', async (req, res) => {
  const start = Date.now()
  const input = { ...DEFAULTS, ...(req.body || {}) }
  const { url, maxScrolls, scrollDelayMs, baseTimeoutMs } = input
  const timeoutMs = maxScrolls * scrollDelayMs + baseTimeoutMs

  if (!url)
    return res.status(400).json({ error: 'Missing "url" in request body' })

  let browser
  let page
  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: BROWSERLESS_WS,
    })

    if (!browser.connected) {
      throw new Error('Browser connection lost immediately after connect')
    }

    page = await browser.newPage()
    await page.setViewport({
      ...input.viewport,
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
    })

    await page.setUserAgent({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    })

    // Many client-side frameworks render after network activity; wait until idle
    await page.goto(url, {
      waitUntil: 'networkidle0',
      timeout: timeoutMs + 30000,
    })

    // Validate connection before starting scroll
    if (!browser.connected) {
      throw new Error('Browser connection lost before scrolling')
    }

    // Perform scrolling to load dynamic content
    let previousHeight
    let scrolls = 0
    while (scrolls < maxScrolls) {
      previousHeight = await page.evaluate('document.body.scrollHeight')
      await page.evaluate('window.scrollTo(0, document.body.scrollHeight)')
      await new Promise((resolve) => setTimeout(resolve, scrollDelayMs)) // Wait for new items to load
      const currentHeight = await page.evaluate('document.body.scrollHeight')
      if (currentHeight === previousHeight) break // Stop if nothing new was added
      scrolls++
    }

    // Wait a bit more for final rendering after scrolling stops
    console.log('Waiting for final page rendering...')
    await new Promise((resolve) => setTimeout(resolve, 2000))

    // After stabilization, grab the complete page HTML using robust extraction
    const html = await page.content()

    // Close page but do not close the shared remote browser
    try {
      if (page && !page.isClosed()) {
        await page.close()
      }
    } catch (e) {
      console.warn('Error closing page:', e.message)
    }

    // Disconnect browser
    try {
      if (browser && browser.connected) {
        await browser.disconnect()
      }
    } catch (e) {
      console.warn('Error disconnecting browser:', e.message)
    }

    const duration = Date.now() - start
    const usedScrolls = scrolls
    return res.json({
      meta: {
        url,
        duration,
        settings: {
          usedScrolls,
          maxScrolls,
          scrollDelayMs,
          timeoutMs,
        },
      },
      html,
    })
  } catch (err) {
    console.error('Scraping error:', err.message)

    try {
      if (page && !page.isClosed()) {
        await page.close()
      }
    } catch (e) {
      console.warn('Error closing page in error handler:', e.message)
    }

    try {
      if (browser && browser.connected) {
        await browser.disconnect()
      }
    } catch (e) {
      console.warn('Error disconnecting browser in error handler:', e.message)
    }

    return res.status(500).json({ error: err.message || String(err) })
  }
})

const port = process.env.PORT || 3000
app.listen(port, () =>
  console.log(
    `Scraper listening on ${port}, using browserless: ${BROWSERLESS_WS}`,
  ),
)
