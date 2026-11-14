import { useState, type FormEvent } from 'react';
import { Check, LoaderCircle } from 'lucide-react';
import type { Workspace } from '../../shared/types';

/** Account/onboarding settings remain editable beside the versioned creative guide. */
export default function WorkspacePreferences({workspace,save,notify}:{workspace:Workspace;save:(patch:Partial<Workspace>)=>Promise<void>;notify:(message:string)=>void}){
  const [busy,setBusy]=useState(false);
  const canEdit=['owner','administrator','editor'].includes(workspace.role);
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();const data=new FormData(event.currentTarget);
    const list=(name:string)=>String(data.get(name)||'').split(',').map(s=>s.trim()).filter(Boolean);
    setBusy(true);
    try{await save({name:String(data.get('name')),creatorType:String(data.get('creatorType')),niches:list('niches'),goals:list('goals')});}
    catch(error){notify(error instanceof Error?error.message:'Workspace details could not be saved.');}
    finally{setBusy(false);}
  }
  return <section className="panel settings-panel" style={{marginTop:24}}><span className="eyebrow">YOUR WORKSPACE</span><h2>Your creator details</h2><p>Update your onboarding details here. Creative preferences live in your Creator DNA Style Guide.</p><form key={`${workspace.id}_${workspace.version}`} onSubmit={submit} className="settings-grid"><label>Workspace name<input name="name" defaultValue={workspace.name} required maxLength={100} readOnly={!canEdit}/></label><label>Creator type<input name="creatorType" defaultValue={workspace.creatorType||''} maxLength={100} readOnly={!canEdit}/></label><label>Content niches <span className="optional">comma separated</span><input name="niches" defaultValue={workspace.niches.join(', ')} maxLength={2000} readOnly={!canEdit}/></label><label>Goals <span className="optional">comma separated</span><input name="goals" defaultValue={workspace.goals.join(', ')} maxLength={2000} readOnly={!canEdit}/></label>{canEdit&&<div><button className="button secondary small" disabled={busy}>{busy?<LoaderCircle className="spin" size={14}/>:<Check size={14}/>}Save workspace details</button></div>}</form></section>;
}
