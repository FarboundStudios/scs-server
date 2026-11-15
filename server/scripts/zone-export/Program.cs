// Standalone GPL-2.0 map export utility. The server consumes JSON only.
using System.IO.Compression;
using System.Numerics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using TruckLib.Models.Ppd;
using TruckLib;
using TruckLib.HashFs;
using TruckLib.ScsMap;

if(args.Length<2){Console.Error.WriteLine("Usage: ZoneExport <game-directory> <output.json> [map.scs ...]");return 2;}
var opened=new List<IDisposable>();
try {
 var sources=new List<IFileSystem>();var names=new List<string>();
 foreach(var path in Directory.GetFiles(args[0],"*.scs").OrderBy(p=>Path.GetFileName(p)=="base_map.scs"?0:1).ThenBy(p=>p).Concat(args.Skip(2))){
  try {
   IFileSystem fs;using(var probe=File.OpenRead(path)){var b=new byte[4];probe.ReadExactly(b);if(b[0]==80&&b[1]==75){var zip=new ZipFs(path);opened.Add(zip);fs=zip;}else{var hash=HashFsReader.Open(path);opened.Add(hash.BaseReader);fs=hash;}}
   sources.Add(fs);if(fs.DirectoryExists("/map/europe")){names.Add(Path.GetFileName(path));Console.Error.WriteLine("Map source: "+Path.GetFileName(path));}
  }catch(InvalidDataException){throw;} // Never silently publish incomplete zones for a bad archive.
 }
 if(!sources.Any())throw new Exception("No europe map sectors found.");
 var overlay=new OverlayFs(sources);var map=new FacilityMap();map.Read("/map/europe",overlay);
 var modelPaths=new Dictionary<string,string>();
 foreach(var file in overlay.GetFiles("/def/world").Where(p=>Path.GetFileName(p).StartsWith("prefab.")&&p.EndsWith(".sii"))){
  var text=overlay.ReadAllText(file);foreach(Match match in Regex.Matches(text,@"prefab_model\s*:\s*prefab\.([^\s{]+)\s*\{([^}]+)\}")){
   var path=Regex.Match(match.Groups[2].Value,"prefab_desc:\\s*\"([^\"]+)\"");if(path.Success)modelPaths[match.Groups[1].Value]=path.Groups[1].Value;
  }
 }
 var descriptors=new Dictionary<string,PrefabDescriptor?>();var zones=new List<object>();var count=new Dictionary<string,int>();var emitted=new HashSet<ulong>();int facilities=0,missing=0,badTransform=0,noGround=0;
 foreach(var item in map.MapItems.Values.OfType<PrefabSlaveItem>()){
  string? kind=item switch {Company=>"depot",Garage=>"garage",Service sv when sv.ServiceType==ServiceType.ServiceStation=>"service",Service sv when sv.ServiceType==ServiceType.TruckDealer=>"dealer",_=>null};if(kind==null)continue;++facilities;
  if(item.Prefab is not Prefab prefab||!modelPaths.TryGetValue(prefab.Model.ToString(),out var path)){++missing;continue;}
  if(emitted.Contains(prefab.Uid))continue;
  if(!descriptors.TryGetValue(path,out var ppd)){ppd=overlay.FileExists(path)?PrefabDescriptor.Open(path,overlay):null;descriptors[path]=ppd;}if(ppd==null){++missing;continue;}
  if(!YardGeometry.TryTransform(prefab,item,ppd,out var transform)){++badTransform;continue;}
  var rings=YardGeometry.GroundRings(ppd).ToList();if(!rings.Any()){++noGround;continue;}
  int added=0;foreach(var ring in rings){var points=ring.Select(i=>transform(ppd.MapPoints[i].Position)).ToList();if(points.Count<3||points.Count>128||points.Max(p=>p.X)-points.Min(p=>p.X)>600||points.Max(p=>p.Z)-points.Min(p=>p.Z)>600)continue;
   zones.Add(new {id=$"yard-{prefab.Uid:x}-{added++}",kind,shape="polygon",y=Math.Round(item.Node.Position.Y,3),height=10,points=points.Select(p=>new[]{Math.Round(p.X,3),Math.Round(p.Z,3)}).ToArray()});count[kind]=count.GetValueOrDefault(kind)+1;
  }if(added>0)emitted.Add(prefab.Uid);else ++noGround;
 }
 Console.Error.WriteLine(JsonSerializer.Serialize(new {facilities,protectedPrefabs=emitted.Count,missing,badTransform,noGround,descriptorModels=descriptors.Count}));
 if(zones.Count==0||zones.Count>50000)throw new Exception("Invalid facility count: "+zones.Count);
 var gameVersion=Environment.GetEnvironmentVariable("HEAVYMP_EXPORT_GAME_VERSION");
 if(gameVersion==null){var executable=Path.Combine(args[0],"bin","win_x64","eurotrucks2.exe");var version=System.Diagnostics.FileVersionInfo.GetVersionInfo(executable);gameVersion=$"{version.FileMajorPart}.{version.FileMinorPart}.{version.FileBuildPart}.{version.FilePrivatePart}s";}
 if(!Regex.IsMatch(gameVersion,@"^\d+\.\d+\.\d+\.\d+s$"))throw new Exception("Invalid export game version");
 var result=new {schema=1,gameVersion,module="europe",generatedAt=DateTime.UtcNow.ToString("O"),sources=names,geometry="prefab-yard-polygons",coverage=new {facilities,protectedPrefabs=emitted.Count,missing,badTransform,noGround},zones};
 var output=Path.GetFullPath(args[1]);Directory.CreateDirectory(Path.GetDirectoryName(output)!);File.WriteAllText(output+".tmp",JsonSerializer.Serialize(result),new UTF8Encoding(false));File.Move(output+".tmp",output,true);
 Console.WriteLine(JsonSerializer.Serialize(new {file=output,zones=zones.Count,kinds=count,items=map.MapItems.Count,nodes=map.Nodes.Count}));return 0;
}catch(Exception e){Console.Error.WriteLine(e.ToString());return 1;}finally{foreach(var d in opened)d.Dispose();}

sealed class FacilityMap:Map {protected override bool PostProcessItem(MapItem item)=>item is PrefabSlaveItem or Prefab;}
sealed class OverlayFs(List<IFileSystem> sources):IFileSystem {
 public char DirectorySeparator=>'/';private IFileSystem Find(string p)=>sources.LastOrDefault(s=>s.FileExists(p))??throw new FileNotFoundException(p);
 public bool FileExists(string p)=>sources.Any(s=>s.FileExists(p));public bool DirectoryExists(string p)=>sources.Any(s=>s.DirectoryExists(p));
 public IList<string> GetFiles(string p)=>sources.Where(s=>s.DirectoryExists(p)).SelectMany(s=>s.GetFiles(p)).Distinct().ToList();
 public byte[] ReadAllBytes(string p)=>Find(p).ReadAllBytes(p);public string ReadAllText(string p)=>Find(p).ReadAllText(p);public string ReadAllText(string p,Encoding e)=>Find(p).ReadAllText(p,e);public Stream Open(string p)=>Find(p).Open(p);public string GetParent(string p)=>p[..p.LastIndexOf('/')];
}
sealed class ZipFs: IFileSystem,IDisposable {
 readonly ZipArchive zip;readonly Dictionary<string,ZipArchiveEntry> files;
 public ZipFs(string path){zip=ZipFile.OpenRead(path);files=zip.Entries.Where(e=>!e.FullName.EndsWith('/')).ToDictionary(e=>"/"+e.FullName.TrimStart('/'),e=>e,StringComparer.Ordinal);}
 public char DirectorySeparator=>'/';public bool FileExists(string p)=>files.ContainsKey(p);public bool DirectoryExists(string p)=>files.Keys.Any(k=>k.StartsWith(p.TrimEnd('/')+"/"));
 public IList<string> GetFiles(string p){var prefix=p.TrimEnd('/')+"/";return files.Keys.Where(k=>k.StartsWith(prefix)&&!k[prefix.Length..].Contains('/')).ToList();}
 public byte[] ReadAllBytes(string p){var e=files[p];if(e.Length>32*1024*1024)throw new InvalidDataException("Map entry too large");using var s=e.Open();using var m=new MemoryStream();s.CopyTo(m);return m.ToArray();}
 public Stream Open(string p)=>new MemoryStream(ReadAllBytes(p));public string ReadAllText(string p)=>ReadAllText(p,Encoding.UTF8);public string ReadAllText(string p,Encoding e)=>e.GetString(ReadAllBytes(p));public string GetParent(string p)=>p[..p.LastIndexOf('/')];public void Dispose()=>zip.Dispose();
}


static class YardGeometry {
 public static IEnumerable<List<int>> GroundRings(PrefabDescriptor ppd){
  // Light-coloured polygon loops describe the facility ground on the map.
  // Do not take road-sized paths, entrance connectors or convex hulls.
  var candidates=ppd.MapPoints.Select((p,i)=>(p,i)).Where(x=>x.p.RoadSize==RoadSize.Polygon&&x.p.Color==CustomColor.Light&&!x.p.PrefabExit).Select(x=>x.i).ToHashSet();var used=new HashSet<int>();
  foreach(var start in candidates){if(used.Contains(start))continue;var ring=new List<int>();int current=start,previous=-1;bool valid=true;
   do {if(ring.Contains(current)){valid=false;break;}ring.Add(current);var neighbors=ppd.MapPoints[current].Neighbors.Where(candidates.Contains).ToList();if(neighbors.Count!=2){valid=false;break;}var next=neighbors.FirstOrDefault(n=>n!=previous,-1);previous=current;current=next;}while(current!=start&&current>=0&&ring.Count<=128);
   foreach(var i in ring)used.Add(i);if(valid&&current==start&&ring.Count>=3&&ring.Count<=128){double area=0;for(int j=0;j<ring.Count;j++){var a=ppd.MapPoints[ring[j]].Position;var b=ppd.MapPoints[ring[(j+1)%ring.Count]].Position;area+=a.X*b.Z-b.X*a.Z;}if(Math.Abs(area)/2>=200)yield return ring;}
  }
 }
 public static bool TryTransform(Prefab prefab,PrefabSlaveItem item,PrefabDescriptor ppd,out Func<Vector3,Vector3> transform){
  transform=p=>p;if(!prefab.Nodes.Any()||!ppd.Nodes.Any()||prefab.Nodes[0].GetType().Name=="UnresolvedNode"||item.Node.GetType().Name=="UnresolvedNode")return false;
  var type=item switch {Company=>SpawnPointType.CompanyPoint,Garage g=>g.IsBuyPoint?SpawnPointType.BuyPoint:SpawnPointType.GaragePoint,Service s when s.ServiceType==ServiceType.ServiceStation=>SpawnPointType.ServiceStation,_=>SpawnPointType.TruckDealer};
  var worldOrigin=prefab.Nodes[0].Position;var worldTarget=item.Node.Position;
  foreach(var node in ppd.Nodes)foreach(var spawn in ppd.SpawnPoints.Where(s=>s.Type==type)){
   var a=spawn.Position-node.Position;var b=worldTarget-worldOrigin;var lengthA=MathF.Sqrt(a.X*a.X+a.Z*a.Z);var lengthB=MathF.Sqrt(b.X*b.X+b.Z*b.Z);if(lengthA<.1f||Math.Abs(lengthA-lengthB)>.25f)continue;
   var angle=MathF.Atan2(b.Z,b.X)-MathF.Atan2(a.Z,a.X);var cs=MathF.Cos(angle);var sn=MathF.Sin(angle);var localOrigin=node.Position;
   Vector3 Apply(Vector3 p){var v=p-localOrigin;return new Vector3(worldOrigin.X+v.X*cs-v.Z*sn,worldOrigin.Y+v.Y,worldOrigin.Z+v.X*sn+v.Z*cs);}
   // Validate every entrance against actual map nodes. A bad orientation skips
   // this prefab; it never falls back to an oversized circular zone.
   if(prefab.Nodes.Where(n=>n.GetType().Name!="UnresolvedNode").Any(n=>!ppd.Nodes.Any(p=>{var delta=Apply(p.Position)-n.Position;return delta.X*delta.X+delta.Z*delta.Z<.25f*.25f;})))continue;
   transform=Apply;return true;
  }return false;
 }
}
