// app.js
import express from 'express'
import bodyParser from 'body-parser'
import puppeteer from 'puppeteer-core'

const app = express()
app.use(bodyParser.json({ limit: '10mb' }))

const DEFAULTS = {
  maxScrolls: 40,
  scrollDelayMs: 1000,
  headless: true,
  viewport: { width: 1200, height: 900 },
  timeoutMs: 120000, // 2 minutes
}

// BROWSERLESS_WS should be like: ws://browserless:3000?ws=true or ws://browserless:3000?token=YOUR_TOKEN
const BROWSERLESS_WS =
  process.env.BROWSERLESS_WS || 'ws://browserless:3000?ws=true'

async function infiniteScroll(page, maxScrolls, delayMs) {
  let lastHeight = await page.evaluate(() => document.body.scrollHeight)
  for (let i = 0; i < maxScrolls; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await new Promise((resolve) => setTimeout(resolve, delayMs))

    try {
      await page.waitForNetworkIdle({ idleTime: 500, timeout: 2000 })
    } catch (e) {
      // ignore network idle timeouts
    }

    const newHeight = await page.evaluate(() => document.body.scrollHeight)
    if (newHeight === lastHeight) {
      await new Promise((resolve) => setTimeout(resolve, 500)) // grace period
      const confirm = await page.evaluate(() => document.body.scrollHeight)
      if (confirm === lastHeight) break
      lastHeight = confirm
    } else {
      lastHeight = newHeight
    }
  }
}

app.post('/scrape', async (req, res) => {
  const start = Date.now()
  const input = { ...DEFAULTS, ...(req.body || {}) }
  const { url, maxScrolls, scrollDelayMs, timeoutMs } = input

  if (!url)
    return res.status(400).json({ error: 'Missing "url" in request body' })

  let browser
  try {
    // Connect to browserless remote browser
    browser = await puppeteer.connect({
      browserWSEndpoint: BROWSERLESS_WS,
      ignoreHTTPSErrors: true,
    })

    const page = await browser.newPage()
    await page.setViewport(input.viewport)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })

    // Run scroll with timeout guard
    await Promise.race([
      infiniteScroll(page, maxScrolls, scrollDelayMs),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error('scroll-timeout')), timeoutMs),
      ),
    ])

    // After scrolling, grab the complete page HTML
    const html = await page.content()

    // Close page but do not close the shared remote browser
    await page.close()
    // disconnect client
    await browser.disconnect()

    const took = Date.now() - start
    return res.json({ meta: { took }, html })
  } catch (err) {
    try {
      if (browser) await browser.disconnect()
    } catch (e) {}
    return res.status(500).json({ error: err.message || String(err) })
  }
})

const port = process.env.PORT || 3000
app.listen(port, () =>
  console.log(
    `Scraper listening on ${port}, using browserless: ${BROWSERLESS_WS}`,
  ),
)
