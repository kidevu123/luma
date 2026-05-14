// UI-2 — small command-center design system.
//                                                         
// Five reusable presentation primitives for the production-floor
// pages. No DB calls, no business logic, no fake data. Composes on
// top of the existing Card / MetricCard / ConfidenceBadge primitives
// — never reimplements them.                           
//                                                  
// Tone vocabulary (single source for the four polished pages):
//   GOOD     = emerald  · running / on-target                                                                
//   WARN     = amber    · degraded / needs review  
//   CRITICAL = red      · blocked / action required                                                          
//   INFO     = cyan     · neutral signal / data window                                                       
//   MUTED    = slate    · missing / idle / legacy                                                            
                                                                                                              
import { cn } from "@/lib/utils";                                                                             
                                                                                  
export type Tone = "GOOD" | "WARN" | "CRITICAL" | "INFO" | "MUTED";                                           
                                                                                                              
const TONE_RAIL: Record<Tone, string> = {          
  GOOD: "bg-emerald-500",                                                                                     
  WARN: "bg-amber-500",                                                           
  CRITICAL: "bg-red-500",                                                                                     
  INFO: "bg-cyan-500",                                                            
  MUTED: "bg-slate-500",                                                                                      
};                                                                                                            
                                                    
const TONE_BORDER: Record<Tone, string> = {                                                                   
  GOOD: "border-emerald-500/40",                                                  
  WARN: "border-amber-500/40",                     
  CRITICAL: "border-red-500/40",                    
  INFO: "border-cyan-500/40",                                                                                 
  MUTED: "border-slate-500/40",                  
};                                                                                                            
                                                                                  
const TONE_BG: Record<Tone, string> = {                                                                       
  GOOD: "bg-emerald-500/5",             
  WARN: "bg-amber-500/5",                                                                                     
  CRITICAL: "bg-red-500/5",                                                       
  INFO: "bg-cyan-500/5",                           
  MUTED: "bg-slate-500/5",                                                                                    
};                                         
                                                                                                              
/** 3-px vertical color rail anchored to the left edge of a card.                 
 *  Caller is responsible for making the parent relatively-positioned. */
export function ProductionStatusRail({                                                                        
  tone,                                                 
  className,                                                                                                  
}: {                                                                              
  tone: Tone;                                                                                                 
  className?: string;                            
}) {                                                                                                          
  return (                                                                        
    <span                                                                                                     
      className={cn(                                
        "absolute inset-y-0 left-0 w-[3px] rounded-l-md",                                                     
        TONE_RAIL[tone],                                                          
        className,                         
      )}                                                
      aria-hidden                                                                                             
    />                                              
  );                                                                                                          
}                                                                                 
                            
/** Page section with eyebrow + title + optional subtitle + optional
 *  actions slot + body. Used to chunk a page into scannable blocks. */                                       
export function ProductionSection({                
  eyebrow,                                                                                                    
  title,                                                                          
  subtitle,                                         
  tone,                                 
  actions,                                       
  children,                                                                                                   
  className,
}: {                                                                                                          
  eyebrow?: string;                                                               
  title: string;                                                                                              
  subtitle?: string;                                                              
  tone?: Tone;                                     
  actions?: React.ReactNode;                        
  children: React.ReactNode;            
  className?: string;                            
}) {                                       
  return (                                              
    <section                                                                                                  
      className={cn(                                
        "relative rounded-md border border-border bg-surface",                                                
        tone ? TONE_BORDER[tone] : null,                                          
        tone ? TONE_BG[tone] : null,       
        className,                                      
      )}                                                                                                      
    >                                               
      {tone ? <ProductionStatusRail tone={tone} /> : null}                                                    
      <header className="flex items-start justify-between gap-3 border-b border-border/40 px-4 py-3">
        <div className="min-w-0">                       
          {eyebrow ? (                                  
            <div className="text-[10px] uppercase tracking-[0.14em] text-text-muted font-semibold">           
              {eyebrow}                             
            </div>                                                                                            
          ) : null}                                                               
          <h2 className="text-sm font-semibold text-text">{title}</h2>
          {subtitle ? (                                                                                       
            <p className="mt-0.5 text-[11px] text-text-muted">{subtitle}</p>                                  
          ) : null}                                                                                           
        </div>                                                                                                
        {actions ? (                                                                                          
          <div className="shrink-0 flex items-center gap-1.5">{actions}</div>
        ) : null}                                                                                             
      </header>                                                                   
      <div className="px-4 py-3">{children}</div>                                                             
    </section>                                   
  );                                                                                                          
}                                                                                 
                                                                                                              
/** Inline alert / banner. Tone drives the rail + border + bg. */
export function ProductionAlertCard({                                                                         
  tone,                                                                           
  title,                                            
  body,                                                                                                       
  action,                                        
  className,                                                                                                  
}: {                                                                              
  tone: Tone;                                                                                                 
  title: string;
  body?: React.ReactNode;                                                                                     
  action?: React.ReactNode;                                                       
  className?: string;                                   
}) {                                               
  return (                                          
    <div                                
      className={cn(                             
        "relative rounded-md border px-3 py-2.5 pl-4",
        TONE_BORDER[tone],                 
        TONE_BG[tone],                                                                                        
        className,                                 
      )}                                                                                                      
      role="status"                                                               
    >                                            
      <ProductionStatusRail tone={tone} />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">                                                                             
          <p className="text-[12px] font-semibold text-text">{title}</p>
          {body ? (                                                                                           
            <div className="mt-0.5 text-[11px] text-text-muted leading-relaxed">  
              {body}
            </div>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    </div>
  );                                       
}                                                       
                                                   
/** Honest empty-state block. Title states what's missing in plain
 *  language; description explains why; optional hint cites the data
 *  source so an operator can verify. Never used for "0 events
 *  occurred" — that should render as a real "0" via MetricCard. */
export function ProductionEmptyState({             
  title,                                                                                                      
  description,                                     
  hint,                                                                                                       
  className,                                                                      
}: {                                             
  title: string;                                                                                              
  description?: React.ReactNode;
  hint?: string;                                                                                              
  className?: string;                                                             
}) {                                                                                                          
  return (                                                                        
    <div                                
      className={cn(                             
        "rounded-md border border-dashed border-border/60 bg-surface/40 px-4 py-6 text-center",
        className,                         
      )}                                                                                                      
    >                                              
      <p className="text-[13px] font-medium text-text">{title}</p>                                            
      {description ? (                                                            
        <p className="mx-auto mt-1 max-w-md text-[11px] text-text-muted leading-relaxed">
          {description}                            
        </p>                                            
      ) : null}                                                                                               
      {hint ? (                                     
        <p className="mt-2 font-mono text-[10px] text-text-muted">{hint}</p>                                  
      ) : null}                                                                   
    </div>                                                                                                    
  );                                               
}                                                                                                             
                                                                                  
/** Compact label-value list. Null / undefined / empty-string values                                          
 *  render as the literal "missing" in muted style. */                            
export type IdentityRow = {                
  label: string;                                                                                              
  value: string | number | null | undefined;       
  /** Render the value in a monospace face — useful for trace codes,                                          
   *  QR strings, UUID prefixes. */                                               
  mono?: boolean;                                       
  /** Tooltip on the value cell. */                
  hint?: string;                                    
};                                                                                                            
                                                   
export function ProductionIdentityBlock({                                                                     
  rows,                                                                           
  columns = 2,                                                                                                
  className,                
}: {                                                                                                          
  rows: IdentityRow[];                                                                                        
  columns?: 1 | 2 | 3 | 4;
  className?: string;                                                                                         
}) {                                                                              
  const gridCls =                                  
    columns === 1                                   
      ? "grid-cols-1"                   
      : columns === 3                            
        ? "grid-cols-1 md:grid-cols-3"     
        : columns === 4                                 
          ? "grid-cols-2 md:grid-cols-4"                                                                      
          : "grid-cols-1 md:grid-cols-2";           
  return (                                                                                                    
    <dl className={cn("grid gap-2", gridCls, className)}>                         
      {rows.map((r, i) => {                         
        const missing = r.value == null || r.value === "";
        return (                                                                                              
          <div                                      
            key={`${r.label}-${i}`}                                                                           
            className="rounded border border-border/60 bg-surface px-2.5 py-1.5"                              
          >                                             
            <dt className="text-[10px] uppercase tracking-[0.10em] text-text-muted font-semibold">            
              {r.label}                                                                                       
            </dt>                                       
            <dd                                                                                               
              className={cn(                                                      
                "mt-0.5 text-[12px]",   
                missing                                                                                       
                  ? "italic text-text-muted"            
                  : r.mono                                                                                    
                    ? "font-mono text-text"                                                                   
                    : "text-text",      
              )}                                                                                              
              title={r.hint}                                                      
            >                                      
              {missing ? "missing" : String(r.value)}                                                         
            </dd>                       
          </div>                                                                                              
        );                                                                        
      })}
    </dl>                                                                                                     
  );                                                    
}
