import {createHash} from 'node:crypto';
export const MAX_TRAILER_SEGMENTS=10;
export function segmentId(owner,index){
 if(!index)return owner;
 const hex=createHash('sha256').update(`heavymp-trailer:${owner}:${index}`).digest('hex').slice(0,32);
 return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export const trailerSegments=state=>Array.isArray(state?.trailers)?state.trailers:state?.trailer?[state.trailer]:[];
export const appearanceSegments=appearance=>appearance?[{plate:appearance.plate,accessories:appearance.accessories},...(appearance.children??[])]:[];
