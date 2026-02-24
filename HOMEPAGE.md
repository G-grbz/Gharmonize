# Gharmonize Homepage Widget

Add Gharmonize as a widget to your Homepage dashboard.

## Requirements

* Homepage ([https://gethomepage.dev](https://gethomepage.dev))
* Gharmonize running instance

## Generate Widget Key

Open Gharmonize settings panel and generate a `HOMEPAGE_WIDGET_KEY`.

## Example Configuration

Add this to your `services.yaml` (or any Homepage service config file):

```yaml
- Gharmonize:
    icon: http://ip:port/src/logo.png
    href: http://ip:port/
    description: Jobs / Queue
    widget:
      type: customapi
      url: http://ip:port/api/homepage
      method: GET
      refreshInterval: 1000
      display: block
      headers:
        X-Widget-Key: YOUR_HOMEPAGE_WIDGET_KEY
        X-Lang: en
      mappings:
        - label: Active
          field: activeCount
          format: number
        - label: Queue
          field: queueCount
          format: number
        - label: Progress
          field: currentProgressText
          format: text
        - label: Completed
          field: completedCount
          format: number
        - label: Processing
          field: processingCount
          format: number
        - label: Error
          field: errorCount
          format: number
        - label: Now
          field: currentPhaseText
          format: text
        - label: Job ID
          field: currentId
          format: text
        - label: Updated
          field: ts
          format: relativeDate
          locale: en
          style: short
          numeric: auto
        - label: Time
          field: ts
          format: date
```

## Supported Languages

`X-Lang` supports: `en`, `de`, `fr`, `tr`.

## Available Fields

You can freely choose which fields you want to display. Simply add or remove mappings based on your needs.

| Field               | Description                            |
| ------------------- | -------------------------------------- |
| activeCount         | Number of currently active jobs        |
| queueCount          | Number of jobs waiting in queue        |
| currentProgressText | Current job progress graph             |
| completedCount      | Total completed jobs                   |
| processingCount     | Jobs currently being processed         |
| errorCount          | Jobs failed with error                 |
| currentPhaseText    | Current processing phase               |
| currentId           | Currently running Job ID               |
| ts                  | Last update timestamp                  |

## API Endpoint

`/api/homepage` returns real‑time job and queue status for Homepage widgets.

---

