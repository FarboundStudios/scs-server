import {formatText} from './text-format.mjs';
// A local index of the available pages. No requests or background work while closed.
export function openPageSearch(pages,current,onChoose,intents=[]){
 if(document.querySelector('dialog[open]'))return;
 const previous=document.activeElement,d=document.createElement('dialog');d.className='manager-dialog page-search';
 d.setAttribute('aria-labelledby','page-search-title');
 const heading=document.createElement('h2');heading.id='page-search-title';heading.textContent='Search pages';
 const input=document.createElement('input');input.type='search';input.placeholder='Search a page or feature…';input.setAttribute('aria-label','Search pages and features');input.autocomplete='off';
 const list=document.createElement('div');list.className='page-search-results';
 const hint=document.createElement('p');hint.className='page-search-hint';hint.textContent='↑ ↓ to navigate · Enter to open · Esc to close';
 d.append(heading,input,list,hint);document.body.append(d);
 const aliases={overview:'home accueil dashboard status',console:'commands commandes annonce announcement',players:'joueurs connected connectes',map:'carte livemap position',addons:'mods ressources resources upload',scripts:'modules plugins telephone phone classic chat',backups:'sauvegardes restore restoration snapshots',automation:'schedules tasks taches programmation restart annonces',performance:'cpu memory memoire tick metrics',chat:'messages historique',moderation:'ban kick mute sanctions',audit:'activity activite actions',settings:'configuration parametres reglages env traffic collisions'};
 const normalize=s=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
 const index=Object.entries(pages).map(([id,[title,description]])=>({id,title,description,text:normalize(title+' '+formatText(title)+' '+description+' '+formatText(description)+' '+(aliases[id]??''))}));
 for(const intent of intents)index.unshift({...intent,text:normalize(intent.title+' '+formatText(intent.title)+' '+intent.description+' '+formatText(intent.description)+' '+intent.terms)});
 const stopWords=new Set('je veux mon ma le la les un une des du de en pour moi faire mettre rendre serveur i want my the a an to make please server ich möchte mein meine den die das einen ein bitte'.split(' '));let selected=0,buttons=[];
 const close=()=>{d.close();d.remove();previous?.focus();};
 const choose=id=>{close();onChoose(id);};
 function highlight(){buttons.forEach((button,i)=>{button.classList.toggle('selected',i===selected);});buttons[selected]?.scrollIntoView({block:'nearest'});}
 function render(){const words=normalize(input.value.trim()).split(/\s+/).filter(word=>word&&!stopWords.has(word)),matches=index.filter(entry=>words.every(word=>entry.text.includes(word)));list.replaceChildren();selected=0;
  for(const entry of matches){const button=document.createElement('button');button.type='button';button.dataset.searchId=entry.id;button.className='page-search-result';const title=document.createElement('strong');title.textContent=formatText(entry.title);const description=document.createElement('span');description.textContent=formatText(entry.description);button.append(title,description);if(entry.id===current)button.setAttribute('aria-current','page');button.onclick=()=>choose(entry.id);list.append(button);}
  buttons=[...list.querySelectorAll('button')];if(!buttons.length){const empty=document.createElement('p');empty.className='page-search-empty';empty.textContent='No matching pages. Try another keyword.';list.append(empty);}highlight();
 }
 input.oninput=render;input.onkeydown=e=>{if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();selected=Math.max(0,Math.min(buttons.length-1,selected+(e.key==='ArrowDown'?1:-1)));highlight();}else if(e.key==='Enter'){e.preventDefault();buttons[selected]?.click();}};
 d.oncancel=e=>{e.preventDefault();close();};d.onclick=e=>{if(e.target===d){const box=d.getBoundingClientRect();if(e.clientX<box.left||e.clientX>box.right||e.clientY<box.top||e.clientY>box.bottom)close();}};
 d.showModal();render();input.focus();
}
