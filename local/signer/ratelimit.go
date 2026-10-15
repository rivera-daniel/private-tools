package main

import (
	"sync"
	"time"
)

// pinLimiter tracks wrong PINs per slot for the lifetime of the process.
type pinLimiter struct {
	mu          sync.Mutex
	maxFailures int
	now         func() time.Time
	slots       map[uint]*pinState
}

type pinState struct {
	failures int
	until    time.Time
}

func newPinLimiter(maxFailures int) *pinLimiter {
	return &pinLimiter{maxFailures: maxFailures, now: time.Now, slots: map[uint]*pinState{}}
}

// check reports whether a PIN attempt on the slot is allowed. When it is not,
// stopped is true if the slot is blocked until restart, otherwise retryAfter
// is the wait in whole seconds.
func (l *pinLimiter) check(slot uint) (ok bool, stopped bool, retryAfter int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	st := l.slots[slot]
	if st == nil {
		return true, false, 0
	}
	if st.failures >= l.maxFailures {
		return false, true, 0
	}
	if wait := st.until.Sub(l.now()); wait > 0 {
		secs := int((wait + time.Second - 1) / time.Second)
		return false, false, secs
	}
	return true, false, 0
}

// fail records a wrong PIN and reports whether the slot is now blocked until restart.
func (l *pinLimiter) fail(slot uint) (stopped bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	st := l.slots[slot]
	if st == nil {
		st = &pinState{}
		l.slots[slot] = st
	}
	st.failures++
	delay := 60
	if st.failures < 6 {
		delay = 1 << st.failures
	}
	if delay > 60 {
		delay = 60
	}
	st.until = l.now().Add(time.Duration(delay) * time.Second)
	return st.failures >= l.maxFailures
}

func (l *pinLimiter) reset(slot uint) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.slots, slot)
}
