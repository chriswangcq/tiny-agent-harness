#!/usr/bin/env node
import { runLegacyRunImMigrationCli } from "../dist/im/legacy-migration.js";

process.exitCode = await runLegacyRunImMigrationCli(process.argv.slice(2));
