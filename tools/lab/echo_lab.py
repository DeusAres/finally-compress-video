import numpy as np
sr=48000
def load(d):
    x=np.fromfile(d+'clean.f32',np.float32).reshape(-1,2).astype(float); y=np.fromfile(d+'echo.f32',np.float32).reshape(-1,2).astype(float)
    # align by xcorr (search ±0.5 s)
    a,b=x.mean(1),y.mean(1); N=1<<int(np.ceil(np.log2(len(a)+len(b)))); c=np.fft.irfft(np.fft.rfft(b,N)*np.conj(np.fft.rfft(a,N)),N); ml=24000
    cc=np.concatenate([c[-ml:],c[:ml+1]]); lag=int(np.argmax(cc))-ml
    if lag>0: y=y[lag:]
    elif lag<0: x=x[-lag:]
    n=min(len(x),len(y)); return x[:n],y[:n],lag
def estimate_H(x,y,N=8192,hop=2048):
    win=np.hanning(N); F=N//2+1; Sxx=np.zeros((F,2,2),complex); Syx=np.zeros((F,2,2),complex)
    for s in range(0,len(x)-N,hop):
        X=np.fft.rfft(x[s:s+N]*win[:,None],axis=0); Y=np.fft.rfft(y[s:s+N]*win[:,None],axis=0)
        Sxx+=np.einsum('fi,fj->fij',X,np.conj(X)); Syx+=np.einsum('fi,fj->fij',Y,np.conj(X))
    reg=1e-6*np.trace(Sxx,axis1=1,axis2=2).real.mean()
    H=np.einsum('fij,fjk->fik',Syx,np.linalg.inv(Sxx+reg*np.eye(2))); h=np.fft.irfft(H,N,axis=0)
    return np.concatenate([h[-240:],h[:3600]])  # t0 at 240
def echo_level(x,z):
    res=[]
    for o in range(2):
        cols=[]
        for i in range(2):
            for k in range(-48,49,4): cols.append(('d',np.roll(x[:,i],k)))
            for k in range(int(.035*sr),int(.050*sr),4): cols.append(('e',np.roll(x[:,i],k)))
        n=min(len(z),len(x)); A=np.stack([c[1][:n] for c in cols],1)[3000:n-3000]; b=z[3000:n-3000,o]
        coef,*_=np.linalg.lstsq(A,b,rcond=None)
        di=[j for j,c in enumerate(cols) if c[0]=='d']; ei=[j for j,c in enumerate(cols) if c[0]=='e']
        d=A[:,di]@coef[di]; e=A[:,ei]@coef[ei]; res.append(round(float(10*np.log10(e.var()/d.var())),1))
    return res
def wiener_deconv(y,hs,lam=1e-2):
    N=1<<int(np.ceil(np.log2(len(y)+len(hs))))
    H=np.fft.rfft(np.roll(np.pad(hs,((0,N-len(hs)),(0,0),(0,0))),-240,axis=0),axis=0)
    Hh=np.conj(np.transpose(H,(0,2,1))); G=np.einsum('fij,fjk->fik',np.linalg.inv(np.einsum('fij,fjk->fik',Hh,H)+lam*np.eye(2)),Hh)
    return np.fft.irfft(np.einsum('fij,fj->fi',G,np.fft.rfft(y,N,axis=0)),N,axis=0)[:len(y)]
