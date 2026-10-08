import { initializeRuntimeEnvironment } from './runtimeEnvironment.js';

// This import must precede routes/modules in every server entry point.
initializeRuntimeEnvironment();
