// Imports new Strava rides. Pure logic over an injected client, so it can be tested without a network.
//
// Each ride costs one request (its streams), and Strava allows 100 requests per 15 minutes, so a run
// imports at most MAX_RIDES_PER_RUN rides and stops early when the rate limit is close. What is left
// over is picked up by the next run: rides already imported are recognised by their Strava id.
import { buildRide } from './rides.js';
import { StravaError, activityToPoints, isBikeActivity } from './strava.js';

export const MAX_RIDES_PER_RUN = 60;
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const RATE_MARGIN = 5; // stop this many requests before the 15-minute limit

function throwIfAborted(signal) {
  if (signal?.aborted) throw Object.assign(new Error('Cancelled.'), { name: 'AbortError' });
}

/**
 * @param {{client:object, afterSec:number, knownIds:Set<number>,
 *          isDuplicate:(ride:object)=>boolean, saveRide:(ride:object)=>Promise<void>,
 *          signal?:AbortSignal, onProgress?:(p:{done:number,total:number,added:number})=>void,
 *          maxRides?:number, build?:typeof buildRide}} options
 *   knownIds: Strava ids already imported or already looked at.
 * @returns {Promise<{added:number, duplicates:number, noGps:number, failed:string[], remaining:number,
 *                    stoppedBy:'limit'|null, skippedIds:number[]}>}
 *   remaining counts rides found but not imported this run. Rejects on login, network and permission
 *   problems; a rate limit is reported through stoppedBy instead.
 */
export async function syncActivities({
  client, afterSec, knownIds, isDuplicate, saveRide, signal, onProgress, maxRides = MAX_RIDES_PER_RUN, build = buildRide,
}) {
  const candidates = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    throwIfAborted(signal);
    const batch = await client.listActivities({ after: afterSec, page, perPage: PAGE_SIZE });
    for (const activity of batch) {
      if (isBikeActivity(activity) && !knownIds.has(activity.id)) candidates.push(activity);
    }
    if (batch.length < PAGE_SIZE) break;
  }
  candidates.sort((a, b) => Date.parse(b.start_date) - Date.parse(a.start_date)); // newest first

  const planned = candidates.slice(0, maxRides);
  const result = {
    added: 0, duplicates: 0, noGps: 0, failed: [], remaining: candidates.length - planned.length, stoppedBy: null, skippedIds: [],
  };

  for (let i = 0; i < planned.length; i++) {
    throwIfAborted(signal);
    const activity = planned[i];

    const usage = client.rateLimit();
    if (usage && usage.usage15 >= usage.limit15 - RATE_MARGIN) {
      result.stoppedBy = 'limit';
      result.remaining += planned.length - i;
      break;
    }

    try {
      const points = activityToPoints(activity, await client.getStreams(activity.id));
      if (!points) {
        result.noGps++;
        result.skippedIds.push(activity.id);
      } else {
        const ride = build({ name: activity.name, source: 'strava', points }, `strava-${activity.id}`);
        ride.stravaId = activity.id;
        if (isDuplicate(ride)) {
          result.duplicates++;
          result.skippedIds.push(activity.id);
        } else {
          await saveRide(ride);
          result.added++;
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      if (err instanceof StravaError) {
        if (err.code === 'limit') {
          result.stoppedBy = 'limit';
          result.remaining += planned.length - i;
          break;
        }
        throw err; // login, network and permission problems affect every ride
      }
      // This ride cannot be used (for example too short): remember it so it is not fetched again.
      result.failed.push(`${activity.name}: ${err.message}`);
      result.skippedIds.push(activity.id);
    }
    onProgress?.({ done: i + 1, total: planned.length, added: result.added });
  }
  return result;
}
