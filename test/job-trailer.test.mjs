import assert from 'node:assert/strict';
import test from 'node:test';
import {validAppearance} from '../server/shared/appearance.mjs';

// Shape of a trailer supplied by the game for a freight job: no data.sii, chassis/, body/ or paint_job/ entry.
const wheel = {kind:3,path:'/def/vehicle/t_wheel/overweight.sii',flags:0,colors:[1,1,1]};
const jobTrailer = () => ({plate:'PLATE',accessories:[
  {kind:1,path:'/def/vehicle/trailer/scs_lowbed/ch_7_3.sii'},
  ...Array.from({length:10},()=>({...wheel})),
  {kind:4,path:'/def/vehicle/trailer/scs_lowbed/custom_paint_job/blue.sii',colors:Array(18).fill(0)},
  {kind:1,path:'/def/vehicle/trailer/scs_lowbed/accessory/long_7_3.sii'},
]});

test('a freight job trailer is shared, with or without a paint job', () => {
  assert.ok(validAppearance(jobTrailer(),true));
  const unpainted=jobTrailer();unpainted.accessories=unpainted.accessories.filter(a=>a.kind!==4);
  assert.ok(validAppearance(unpainted,true));
});

test('a trailer keeps its other limits and a tractor keeps its required parts', () => {
  const twice=jobTrailer();twice.accessories.push({...twice.accessories[11]});
  assert.equal(validAppearance(twice,true),null);
  const outside=jobTrailer();outside.accessories[0]={kind:1,path:'/def/economy_data.sii'};
  assert.equal(validAppearance(outside,true),null);
  assert.equal(validAppearance(jobTrailer(),false),null);
});
