import fs from 'node:fs'
import path from 'node:path'

export const maintenancePaused = home => fs.existsSync(path.join(home, 'whale-maintenance.json'))
