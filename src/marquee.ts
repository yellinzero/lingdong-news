// Motion is composited by Web Animations; JS only changes play/pause/track state.
// The logical clock keeps paging deterministic even when WebKit throttles JS frames.
export class Marquee {
  private animation:Animation|null=null;
  private origin=0;
  private started=0;
  private speed=0;
  private target=0;
  private running=false;
  constructor(private element:HTMLElement){}
  position(now=performance.now()):number {return this.running?Math.min(this.target,this.origin+(now-this.started)*this.speed/1000):this.origin;}
  jump(offset:number){this.animation?.cancel();this.animation=null;this.running=false;this.origin=Math.max(0,offset);this.element.style.transform=`translate3d(${-this.origin}px,0,0)`;}
  pauseVisual(now=performance.now()){
    const time=this.animation?.currentTime;
    const offset=this.running&&typeof time==='number'?Math.min(this.target,this.origin+time*this.speed/1000):this.position(now);
    this.jump(offset);return offset;
  }
  syncVisual(now=performance.now()){if(this.animation)this.animation.currentTime=(this.position(now)-this.origin)*1000/this.speed;}
  pause(now=performance.now()){if(this.running)this.jump(this.position(now));}
  play(end:number,speed:number,now=performance.now()){
    if(this.running&&this.target===end&&this.speed===speed)return;
    if(this.running&&this.target!==end)this.pauseVisual(now);
    const from=this.position(now);end=Math.max(end,from);this.jump(from);
    if(end<=from||speed<=0)return;
    this.origin=from;this.target=end;this.speed=speed;this.started=now;this.running=true;
    this.animation=this.element.animate([{transform:`translate3d(${-from}px,0,0)`},{transform:`translate3d(${-end}px,0,0)`}],{duration:(end-from)*1000/speed,easing:'linear',fill:'forwards'});
  }
  dispose(){this.animation?.cancel();this.animation=null;this.running=false;}
}
