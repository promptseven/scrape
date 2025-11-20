# Scrape

Scrape infinite websites. This service uses a headless browser to load web pages that implement infinite scrolling, allowing you to extract content that is dynamically loaded as you scroll down the page.

## Usage

```yaml
services:
  browserless:
    image: browserless/chrome:latest
    ports:
      - '3000:3000'
    environment:
      - MAX_CONCURRENT_SESSIONS=2
    restart: unless-stopped

  scraper:
    image: ghcr.io/promptseven/scrape:latest
    ports:
      - '3001:3001'
    environment:
      - PORT=3001
      - BROWSERLESS_WS=ws://browserless:3000?ws=true
    depends_on:
      - browserless
    restart: unless-stopped
```

To test the scraping functionality, you can use the following `curl` command:

```bash
curl -X POST http://localhost:3001/scrape -H "Content-Type: application/json" -d '{"url":"https://example.com/infinite-scroll","maxScrolls":0}'
```

## Parameters

The following parameters can be configured in the request body:

| Parameter           | Type    | Default | Description                                                       |
| ------------------- | ------- | ------- | ----------------------------------------------------------------- |
| `maxScrolls`        | integer | 0       | Maximum number of scroll actions to perform (0 = no scrolling).   |
| `scrollDelayMs`     | integer | 2000    | Delay in milliseconds between scroll actions to wait for content. |
| `scrollPostDelayMs` | integer | 2000    | Additional delay in milliseconds after completing all scrolls.    |
| `idleTimeoutMs`     | integer | 30000   | Timeout in milliseconds for page idle state detection.            |
| `headless`          | boolean | true    | Whether to run the browser in headless mode.                      |
| `viewport.width`    | integer | 1200    | Browser viewport width in pixels.                                 |
| `viewport.height`   | integer | 900     | Browser viewport height in pixels.                                |
| `baseTimeoutMs`     | integer | 10000   | Base timeout in milliseconds for page operations.                 |
| `contentExtraction` | string  | 'html'  | Content extraction format ('html', 'body', 'links').              |

## License

[MIT](LICENSE)
