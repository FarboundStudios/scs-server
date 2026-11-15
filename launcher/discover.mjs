import {discoverCommunityServer} from './server-discovery.mjs';

try{
 const address=process.argv[2];
 if(!address)throw Error('Usage: npm run discover -- https://your-server.example');
 console.log(JSON.stringify(await discoverCommunityServer(address),null,2));
}catch(error){
 console.error(error.message);
 process.exitCode=1;
}
