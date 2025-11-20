// app.js
import express from 'express'
import bodyParser from 'body-parser'
import puppeteer from 'puppeteer-core'

const app = express()
app.use(bodyParser.json({ limit: '10mb' }))

const DEFAULTS = {
  maxScrolls: 400,
  scrollDelayMs: 20000,
  headless: true,
  viewport: { width: 1200, height: 900 },
  timeoutMs: 1200000, // 20 minutes
}

// BROWSERLESS_WS should be like: ws://browserless:3000?ws=true or ws://browserless:3000?token=YOUR_TOKEN
const BROWSERLESS_WS =
  process.env.BROWSERLESS_WS || 'ws://browserless:3000?ws=true'

// Scroll to bottom repeatedly (up to maxScrolls) and wait until the
// target container's DOM tree stops growing (no new elements) for a
// continuous idle period (`idleMs`). The function respects an overall
// `timeoutMs` and returns true if stability was reached, false if timed out.
async function scrollToBottomAndWaitForStability(
  page,
  selector,
  maxScrolls = 40,
  timeoutMs = 120000,
  idleMs = 2000,
  checkIntervalMs = 500,
) {
  const endTime = Date.now() + timeoutMs

  // helper to get number of nodes inside the element (or document)
  const getCount = async () =>
    page.evaluate((sel) => {
      const el =
        document.querySelector(sel) ||
        document.scrollingElement ||
        document.body
      return el.querySelectorAll('*').length
    }, selector)

  let lastCount = await getCount()

  for (
    let attempt = 0;
    attempt < maxScrolls && Date.now() < endTime;
    attempt++
  ) {
    // scroll the target to its bottom
    await page.evaluate((sel) => {
      const el =
        document.querySelector(sel) ||
        document.scrollingElement ||
        document.body
      try {
        if (
          el === document.scrollingElement ||
          el === document.body ||
          el === document.documentElement
        ) {
          window.scrollTo({ top: el.scrollHeight, behavior: 'auto' })
        } else {
          el.scrollTop = el.scrollHeight
        }
      } catch (e) {}
    }, selector)

    // Wait and observe until no new elements are added for idleMs
    let stableStart = null
    while (Date.now() < endTime) {
      await new Promise((r) => setTimeout(r, checkIntervalMs))
      const cur = await getCount()
      if (cur === lastCount) {
        if (!stableStart) stableStart = Date.now()
        if (Date.now() - stableStart >= idleMs) return true
      } else {
        // New elements were added; update lastCount and continue waiting
        lastCount = cur
        stableStart = null
      }
    }
    // if we get here, overall timeout reached; break
    break
  }

  // timed out or reached max attempts without stability
  return false
}

// Find the most likely scrollable container and mark it with a temporary attribute
// so other functions can reference it via selector.
async function getScrollTargetSelector(page) {
  const sel = await page.evaluate(() => {
    try {
      const nodes = Array.from(document.querySelectorAll('body, html, *'))
      let best = document.scrollingElement || document.body
      let bestDelta = (best.scrollHeight || 0) - (best.clientHeight || 0)
      for (const n of nodes) {
        const delta = (n.scrollHeight || 0) - (n.clientHeight || 0)
        if (delta > bestDelta) {
          best = n
          bestDelta = delta
        }
      }
      // mark the element so we can use a selector from node context
      best.setAttribute('data-scrape-scroll', '1')
      return '[data-scrape-scroll="1"]'
    } catch (e) {
      return '[data-scrape-scroll="1"]'
    }
  })
  return sel
}

// Wait until a specific element's innerHTML length stabilizes
// (removed) element-level stability helper — not used anymore

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
    // Set a common browser user-agent to reduce bot-blocking
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    )
    // Many client-side frameworks render after network activity; wait for network idle
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 })

    // Detect scrollable container and mark it with an attribute selector
    const scrollSelector = await getScrollTargetSelector(page)

    // New strategy: scroll-to-bottom and wait until no new elements are added
    // for a continuous idle period. Allow tuning via request params.
    const stabilityIdleMs =
      input.stabilityIdleMs ||
      Math.max(500, Math.min(2000, scrollDelayMs || 800))
    const checkIntervalMs = input.checkIntervalMs || 500

    const stable = await scrollToBottomAndWaitForStability(
      page,
      scrollSelector,
      maxScrolls,
      timeoutMs,
      stabilityIdleMs,
      checkIntervalMs,
    )

    // remove the temporary attribute marker
    try {
      await page.evaluate((sel) => {
        const el = document.querySelector(sel)
        if (el) el.removeAttribute('data-scrape-scroll')
      }, scrollSelector)
    } catch (e) {}

    if (!stable) {
      // proceed anyway, but include a warning in the response meta
      console.warn('scrolling did not reach stability before timeout')
    }

    // After stabilization, grab the complete page HTML
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
