// app.js
import express from 'express'
import bodyParser from 'body-parser'
import puppeteer from 'puppeteer-core'

const app = express()
app.use(bodyParser.json({ limit: '10mb' }))

const DEFAULTS = {
  maxScrolls: 40,
  scrollDelayMs: 5000,
  headless: true,
  viewport: { width: 1200, height: 900 },
  timeoutMs: 1200000, // 20 minutes
}

// BROWSERLESS_WS should be like: ws://browserless:3000?ws=true or ws://browserless:3000?token=YOUR_TOKEN
const BROWSERLESS_WS =
  process.env.BROWSERLESS_WS || 'ws://browserless:3000?ws=true'

// Retry browser connection with exponential backoff
async function connectWithRetry(maxRetries = 3, baseDelay = 1000) {
  let lastError
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Attempting browser connection (${attempt}/${maxRetries})...`)
      const browser = await puppeteer.connect({
        browserWSEndpoint: BROWSERLESS_WS,
        ignoreHTTPSErrors: true,
        timeout: 30000, // 30 second connection timeout
      })

      // Validate connection is working
      if (browser.isConnected()) {
        console.log('Browser connection established successfully')
        return browser
      } else {
        await browser.disconnect().catch(() => {})
        throw new Error('Browser connected but not ready')
      }
    } catch (error) {
      lastError = error
      console.warn(`Connection attempt ${attempt} failed:`, error.message)

      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt - 1)
        console.log(`Retrying in ${delay}ms...`)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  }
  throw new Error(
    `Failed to connect after ${maxRetries} attempts: ${lastError.message}`,
  )
}

// Robust content extraction with multiple fallback methods
async function extractPageContent(page, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (page.isClosed()) {
        return '<html><body><!-- Page closed before content extraction --></body></html>'
      }

      // Method 1: Try page.content() directly
      console.log(`Content extraction attempt ${attempt}/${maxRetries}...`)
      const html = await page.content()
      if (html && html.length > 100) {
        console.log(`Content extracted successfully (${html.length} chars)`)
        return html
      }

      // Method 2: If content is too short, try getting documentElement.outerHTML
      console.log('Trying alternative content extraction...')
      const altHtml = await page.evaluate(() => {
        return document.documentElement.outerHTML
      })

      if (altHtml && altHtml.length > 100) {
        console.log(`Alternative content extracted (${altHtml.length} chars)`)
        return altHtml
      }

      throw new Error('Content too short or empty')
    } catch (error) {
      console.warn(
        `Content extraction attempt ${attempt} failed:`,
        error.message,
      )

      if (attempt < maxRetries) {
        // Wait before retry
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))

        // Try to wait for page stability
        try {
          if (!page.isClosed()) {
            await new Promise((resolve) => setTimeout(resolve, 500))
          }
        } catch (e) {
          // Ignore wait errors
        }
      } else {
        // Last attempt failed, return fallback
        console.error('All content extraction attempts failed')
        return '<html><body><!-- Content extraction failed after retries --></body></html>'
      }
    }
  }
}

// Scroll to bottom repeatedly (up to maxScrolls) and wait until the
// target container's DOM tree stops growing (no new elements) for a
// continuous idle period (`idleMs`). The function respects an overall
// `timeoutMs` and returns true if stability was reached, false if timed out.
async function scrollToBottomAndWaitForStability(
  page,
  selector,
  maxScrolls = 40,
  timeoutMs = 120000,
  idleMs = 1000,
  checkIntervalMs = 500,
) {
  const endTime = Date.now() + timeoutMs

  // helper to get number of nodes inside the element (or document)
  const getCount = async () => {
    try {
      if (page.isClosed()) return 0
      return await page.evaluate((sel) => {
        const el =
          document.querySelector(sel) ||
          document.scrollingElement ||
          document.body
        return el.querySelectorAll('*').length
      }, selector)
    } catch (e) {
      // Frame detached or page closed
      return 0
    }
  }

  let lastCount = await getCount()

  for (
    let attempt = 0;
    attempt < maxScrolls && Date.now() < endTime;
    attempt++
  ) {
    // Check if page is still connected before each scroll
    if (page.isClosed()) {
      console.warn('Page closed during scroll, stopping')
      break
    }

    // scroll the target to its bottom
    try {
      if (page.isClosed()) break
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
    } catch (e) {
      // Frame detached or connection lost, break out of scroll loop
      console.warn(
        'Frame detached or connection lost during scroll, stopping:',
        e.message,
      )
      break
    }

    // Wait and observe until no new elements are added for idleMs
    let stableStart = null
    while (Date.now() < endTime) {
      await new Promise((r) => setTimeout(r, checkIntervalMs))

      // Check page state before counting elements
      if (page.isClosed()) {
        console.warn('Page closed during stability check, stopping')
        return false
      }

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
  try {
    if (page.isClosed()) return '[data-scrape-scroll="1"]'
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
  } catch (e) {
    // Frame detached, return fallback
    return '[data-scrape-scroll="1"]'
  }
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
  let page
  try {
    // Connect to browserless remote browser with retry logic
    browser = await connectWithRetry()

    // Validate browser connection before proceeding
    if (!browser.isConnected()) {
      throw new Error('Browser connection lost immediately after connect')
    }

    page = await browser.newPage()
    await page.setViewport(input.viewport)

    // Set a common browser user-agent to reduce bot-blocking
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    )

    // Add connection lost handler
    browser.on('disconnected', () => {
      console.warn('Browser connection lost during operation')
    })

    // Many client-side frameworks render after network activity; wait for network idle
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 900000 })

    // Detect scrollable container and mark it with an attribute selector
    if (!browser.isConnected()) {
      throw new Error('Browser connection lost before scroll detection')
    }
    const scrollSelector = await getScrollTargetSelector(page)

    // New strategy: scroll-to-bottom and wait until no new elements are added
    // for a continuous idle period. Allow tuning via request params.
    const stabilityIdleMs =
      input.stabilityIdleMs ||
      Math.max(500, Math.min(2000, scrollDelayMs || 800))
    const checkIntervalMs = input.checkIntervalMs || 500

    // Validate connection before starting scroll
    if (!browser.isConnected()) {
      throw new Error('Browser connection lost before scrolling')
    }

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

    // Wait a bit more for final rendering after scrolling stops
    console.log('Waiting for final page rendering...')
    await new Promise((resolve) => setTimeout(resolve, 2000))

    // After stabilization, grab the complete page HTML using robust extraction
    const html = await extractPageContent(page)

    // Close page but do not close the shared remote browser
    try {
      if (page && !page.isClosed()) {
        await page.close()
      }
    } catch (e) {
      console.warn('Error closing page:', e.message)
    }

    // disconnect client
    try {
      if (browser && browser.isConnected()) {
        await browser.disconnect()
      }
    } catch (e) {
      console.warn('Error disconnecting browser:', e.message)
    }

    const took = Date.now() - start
    return res.json({
      meta: {
        took,
        stable: !!stable,
        settings: {
          maxScrolls,
          scrollDelayMs,
          timeoutMs,
          stabilityIdleMs,
          checkIntervalMs,
        },
      },
      html,
    })
  } catch (err) {
    console.error('Scraping error:', err.message)

    // Enhanced cleanup
    try {
      if (page && !page.isClosed()) {
        await page.close()
      }
    } catch (e) {
      console.warn('Error closing page in error handler:', e.message)
    }

    try {
      if (browser && browser.isConnected()) {
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
