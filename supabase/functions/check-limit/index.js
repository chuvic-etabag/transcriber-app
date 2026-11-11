// Edge Function "check-limit". The work is in ../_shared/handlers.js (checkLimit).
import { checkLimit } from '../_shared/handlers.js';

Deno.serve(checkLimit);
