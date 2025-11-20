// app.js
const express = require('express')
const bodyParser = require('body-parser')
const puppeteer = require('puppeteer-core')

const app = express()
app.use(bodyParser.json({ limit: '10mb' }))

const DEFAULTS = {
  itemSelector: 'article.post',
  titleSelector: 'h2',
  linkSelector: 'a',
  maxScrolls: 40,
  scrollDelayMs: 800,
  headless: true,
  viewport: { width: 1200, height: 900 },
  timeoutMs: 120000,
}

// BROWSERLESS_WS should be like: ws://browserless:3000?ws=true or ws://browserless:3000?token=YOUR_TOKEN
const BROWSERLESS_WS =
  process.env.BROWSERLESS_WS || 'ws://browserless:3000?ws=true'

async function infiniteScroll(page, maxScrolls, delayMs) {
  let lastHeight = await page.evaluate(() => document.body.scrollHeight)
  for (let i = 0; i < maxScrolls; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await page.waitForTimeout(delayMs)

    try {
      await page.waitForNetworkIdle({ idleTime: 500, timeout: 2000 })
    } catch (e) {
      // ignore network idle timeouts
    }

    const newHeight = await page.evaluate(() => document.body.scrollHeight)
    if (newHeight === lastHeight) {
      await page.waitForTimeout(500) // grace period
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
  const {
    url,
    itemSelector,
    titleSelector,
    linkSelector,
    maxScrolls,
    scrollDelayMs,
    timeoutMs,
  } = input

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

    const results = await page.$$eval(
      itemSelector,
      (nodes, titleSel, linkSel) =>
        nodes.map((node) => {
          const titleEl = node.querySelector(titleSel)
          const linkEl = node.querySelector(linkSel)
          return {
            title: titleEl ? titleEl.innerText.trim() : null,
            url: linkEl ? linkEl.href || linkEl.getAttribute('href') : null,
            html: node.innerHTML,
          }
        }),
      titleSelector,
      linkSelector,
    )

    // Close page but do not close the shared remote browser
    await page.close()
    // disconnect client
    await browser.disconnect()

    const took = Date.now() - start
    return res.json({ meta: { count: results.length, took }, results })
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
