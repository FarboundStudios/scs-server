export const canUseStaffVehicles=session=>session?.staff===true;
export function isStaffVehicle(appearance){
 return appearance?.accessories?.some(a=>/^\/def\/vehicle\/truck\/heavymp\.(megane|ambulance)\//.test(a.path))===true;
}
export function staffVehicleState(state){
 return /^heavymp\.(megane|ambulance)$/.test(state?.truck?.identity?.model??'');
}
