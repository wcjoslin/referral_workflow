/**
 * EDI File Watcher for X12N 277 Inbound Messages
 *
 * Watches a configured directory for new .edi files.
 * On file creation, parses the 277, ingests to DB, and moves to processed subdir.
 */

import * as fs from 'fs';
import * as path from 'path';
import { watch } from 'chokidar';
import { config } from '../../../config';
import { parseX12_277, ParseError } from './x12_277Parser';
import { ingestRequest } from './requestService';

let isRunning = false;

export async function startEdiWatcher(): Promise<void> {
  if (isRunning) {
    console.log('[EdiWatcher] Already running');
    return;
  }

  const watchDir = config.claims.watchDir;

  // Create directories if they don't exist
  ensureDir(watchDir);
  ensureDir(path.join(watchDir, 'processed'));
  ensureDir(path.join(watchDir, 'failed'));

  isRunning = true;
  console.log(`[EdiWatcher] Starting file watcher on ${watchDir}`);

  const watcher = watch(watchDir, {
    ignored: (filePath: string) => {
      // Ignore dot files, swp files, and anything in processed/failed directories
      const file = path.basename(filePath);
      if (file.startsWith('.') || file.endsWith('.swp')) {
        return true;
      }
      // Check if path contains processed or failed directories
      const normalized = path.normalize(filePath);
      return normalized.includes(path.sep + 'processed' + path.sep) ||
             normalized.includes(path.sep + 'failed' + path.sep);
    },
    persistent: true,
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 100,
    },
  });

  watcher
    .on('add', (filePath: string) => {
      handleNewFile(filePath, watchDir).catch((err: unknown) => {
        console.error(`[EdiWatcher] Error processing ${filePath}:`, err);
      });
    })
    .on('error', (err: unknown) => {
      console.error('[EdiWatcher] Watcher error:', err);
    });

  console.log('[EdiWatcher] Watcher started');
}

async function handleNewFile(filePath: string, watchDir: string): Promise<void> {
  const fileName = path.basename(filePath);

  // Only process .edi files
  if (!fileName.endsWith('.edi')) {
    return;
  }

  // Skip files already in processed or failed directories
  const normalizedPath = path.normalize(filePath);
  const processedDir = path.normalize(path.join(watchDir, 'processed'));
  const failedDir = path.normalize(path.join(watchDir, 'failed'));

  if (normalizedPath.startsWith(processedDir) || normalizedPath.startsWith(failedDir)) {
    console.log(`[EdiWatcher] Skipping already-handled file: ${fileName}`);
    return;
  }

  console.log(`[EdiWatcher] Processing new file: ${fileName}`);

  try {
    // Read the file
    const ediText = fs.readFileSync(filePath, 'utf-8');

    // Parse X12 277
    const parsed277 = parseX12_277(ediText);

    // Ingest to database (non-blocking document build happens inside)
    const requestId = await ingestRequest(parsed277, fileName);

    console.log(`[EdiWatcher] Successfully ingested 277 as request ${requestId}`);

    // Move file to processed directory
    const processedPath = path.join(watchDir, 'processed', fileName);
    fs.renameSync(filePath, processedPath);
    console.log(`[EdiWatcher] Moved to processed: ${processedPath}`);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[EdiWatcher] Failed to process ${fileName}: ${errorMsg}`);
    // Leave file in place for manual inspection; don't move to avoid recursion
  }
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}
