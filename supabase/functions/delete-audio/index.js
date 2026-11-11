// Edge Function "delete-audio". The work is in ../_shared/handlers.js (deleteAudio).
import { deleteAudio } from '../_shared/handlers.js';

Deno.serve(deleteAudio);
