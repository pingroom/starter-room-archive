import { archiveConfig, loadEnvironment } from './config.js';
import { searchArchive, safeJson } from './search-archive.js';
import { errorSummary } from './errors.js';

try {
  loadEnvironment();
  console.log(safeJson(await searchArchive(archiveConfig().root, process.argv.slice(2).join(' '))));
} catch (error) { console.error(errorSummary(error)); process.exitCode = 1; }
