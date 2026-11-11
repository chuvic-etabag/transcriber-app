// Edge Function "start-job". The work is in ../_shared/handlers.js (startJob).
import { startJob } from '../_shared/handlers.js';

Deno.serve(startJob);
