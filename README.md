# @tutorializer/tours

The product-side browser runtime for [Tutorializer](https://tutorializer.com).
It reads a checked-in `tours.json`, renders the Tutorializer cursor, performs
real user interactions, and communicates step progress to
`@tutorializer/react` through `postMessage`.

## Install from GitHub

Pin a commit so the generated tutorial remains reproducible:

```bash
npm install github:tutorializer/tours#COMMIT_SHA
```

## Initialize the product

```js
import { initTourRunner } from '@tutorializer/tours/TourRunner.js'

import tours from './tours.json'

initTourRunner(tours)
```

```json
{
  "create-task": {
    "name": "create-task",
    "steps": [
      {
        "step": 1,
        "action": "click",
        "selector": "[data-testid='new-task']",
        "description": "Create a task"
      },
      {
        "step": 2,
        "action": "type",
        "selector": "[name='title']",
        "value": "Publish the launch checklist",
        "description": "Enter the task title"
      }
    ]
  }
}
```

Selectors should be stable product contracts such as accessible names or
`data-testid` attributes. The companion React shell asks this runtime for the
steps and coordinates camera movement, optional narration, and completion.

The internal source-analysis generator and Tutorializer's recording,
speech-synthesis, database, and publishing services are intentionally not
part of this browser package.

## License

MIT
