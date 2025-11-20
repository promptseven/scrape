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

async function infiniteScroll(page, maxScrolls, delayMs) {
  // Step-scroll the detected scroll target (window or a scrollable container)
  // The `scrollTarget` object should be set by `getScrollTarget` and attached as
  // an attribute selector on the page before calling this function.
  const scrollSelector = '[data-scrape-scroll="1"]'
  // initial height (or scrollHeight of the container)
  let lastHeight = await page.evaluate((sel) => {
    const el =
      document.querySelector(sel) || document.scrollingElement || document.body
    return el.scrollHeight
  }, scrollSelector)

  for (let i = 0; i < maxScrolls; i++) {
    await page.evaluate((sel) => {
      const el =
        document.querySelector(sel) ||
        document.scrollingElement ||
        document.body
      const step = Math.max(window.innerHeight, 400)
      if (
        el === document.scrollingElement ||
        el === document.body ||
        el === document.documentElement
      ) {
        window.scrollBy({ top: step, left: 0, behavior: 'auto' })
      } else {
        el.scrollBy(0, step)
      }
    }, scrollSelector)

    // wait a bit for rendering / XHR to start
    await new Promise((resolve) => setTimeout(resolve, delayMs))

    try {
      // wait a bit longer for network activity to settle for client-side frameworks
      await page.waitForNetworkIdle({ idleTime: 1000, timeout: 5000 })
    } catch (e) {
      // ignore network idle timeouts
    }

    const newHeight = await page.evaluate((sel) => {
      const el =
        document.querySelector(sel) ||
        document.scrollingElement ||
        document.body
      return el.scrollHeight
    }, scrollSelector)

    if (newHeight === lastHeight) {
      // give a short grace period and re-check — handles slow lazy-loading
      await new Promise((resolve) => setTimeout(resolve, 750))
      const confirm = await page.evaluate((sel) => {
        const el =
          document.querySelector(sel) ||
          document.scrollingElement ||
          document.body
        return el.scrollHeight
      }, scrollSelector)
      if (confirm === lastHeight) break
      lastHeight = confirm
    } else {
      lastHeight = newHeight
    }
  }
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
async function waitForElementStability(
  page,
  selector,
  attempts = 50,
  intervalMs = 10000,
) {
  let prev = await page.evaluate((sel) => {
    const el = document.querySelector(sel) || document.documentElement
    return el.innerHTML.length
  }, selector)
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, intervalMs))
    const cur = await page.evaluate((sel) => {
      const el = document.querySelector(sel) || document.documentElement
      return el.innerHTML.length
    }, selector)
    if (cur === prev) return true
    prev = cur
  }
  return false
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
    // Set a common browser user-agent to reduce bot-blocking
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    )
    // Many client-side frameworks render after network activity; wait for network idle
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 })

    // Detect scrollable container and mark it with an attribute selector
    const scrollSelector = await getScrollTargetSelector(page)

    // Run scroll with timeout guard (scrolls the detected container)
    await Promise.race([
      infiniteScroll(page, maxScrolls, scrollDelayMs),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error('scroll-timeout')), timeoutMs),
      ),
    ])

    // After scrolling, wait for the container's HTML to stabilize
    await waitForElementStability(
      page,
      scrollSelector,
      8,
      Math.max(500, Math.min(2000, scrollDelayMs || 800)),
    )

    // remove the temporary attribute marker
    try {
      await page.evaluate((sel) => {
        const el = document.querySelector(sel)
        if (el) el.removeAttribute('data-scrape-scroll')
      }, scrollSelector)
    } catch (e) {}

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
