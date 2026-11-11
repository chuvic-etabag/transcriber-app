// Edge Function "job-status". The work is in ../_shared/handlers.js (jobStatus).
import { jobStatus } from '../_shared/handlers.js';

Deno.serve(jobStatus);
