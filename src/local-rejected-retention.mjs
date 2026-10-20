// No I/O at import. Native binding used only by explicit preparation/admitted operation.
import * as fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createLocalRejectedRetention} from './internal/local-rejected-retention.mjs';
export const RETENTION_POLICY=Object.freeze({enabled:true,slot_capacity:5,max_bytes_per_file:65536,max_lifetime_ms:86400000,access:'LOCAL_HUMAN_ONLY_NO_REMOTE_RAW_READ'});
export function createNativeRejectedRetention(job_id){
 return createLocalRejectedRetention({fs,root:'/home/zack/.local/state/squire/diagnostics',uid:process.getuid(),now:Date.now,randomUUID,job_id});
}
