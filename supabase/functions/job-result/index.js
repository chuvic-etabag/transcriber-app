// Edge Function "job-result". The work is in ../_shared/handlers.js (jobResult).
import { jobResult } from '../_shared/handlers.js';

Deno.serve(jobResult);
