/**
 * The shape of a room while the workplace is switching into it, under the
 * agents picker's room tab (`RoomView`).
 *
 * It was the first shape of Home too, back when Home opened on the Workplace
 * half; Home is the Chief of Staff's conversation now and holds its own
 * shape (`HomeLoadingSkeleton`, note #718). What stays is the room's wait:
 * the briefing card, the seat strip and one shelf row, stable enough to hold
 * without inventing any account-specific words.
 */

function Bar({ width, height = 11, delay }: {
  width: string;
  height?: number;
  delay?: string;
}) {
  return (
    <span
      className="skel workplace-loading-bar"
      style={{ width, height: `${height}px`, ...(delay ? { animationDelay: delay } : {}) }}
    />
  );
}

function RecapCard() {
  return (
    <div className="card recapbrief workplace-loading-recap">
      <div className="recapbody">
        <Bar width="88%" height={13} delay=".06s" />
        <Bar width="74%" height={13} delay=".12s" />
        <Bar width="46%" height={13} delay=".18s" />
        <div className="recapfoot"><Bar width="35%" height={10} delay=".24s" /></div>
      </div>
    </div>
  );
}

function SeatStrip() {
  return (
    <div className="seatsection workplace-loading-seats">
      <div className="seatstrip">
        {[0, 1, 2].map((at) => (
          <div className="seatcard" key={at}>
            <Bar width={at === 1 ? '62%' : '74%'} height={11} delay={`${(at * 0.09).toFixed(2)}s`} />
            <Bar width={at === 2 ? '44%' : '56%'} height={9} delay={`${(at * 0.09 + 0.05).toFixed(2)}s`} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** What stands under the sign-ins: one shelf row, the shape Drive has. The
 *  cloud card held this place until note #642 moved it to the workplace
 *  screen, and a wait must promise the shape that is actually coming. */
function ShelfCard() {
  return (
    <div className="card workplace-loading-shelf">
      <div className="crow">
        <span className="skel workplace-loading-mark" />
        <div className="main">
          <Bar width="38%" height={12} delay=".09s" />
          <Bar width="56%" height={10} delay=".14s" />
        </div>
        <Bar width="9px" height={16} delay=".18s" />
      </div>
    </div>
  );
}

export function WorkplaceLoadingSkeleton({ stage }: { stage: 'app' | 'workplace' }) {
  const label = stage === 'app' ? 'Loading your workspace…' : 'Loading your workplace…';
  return (
    <div
      className="screen workplace-loading"
      id={stage === 'app' ? 'appLoadingSkeleton' : 'workplaceLoadingSkeleton'}
      aria-busy="true"
    >
      <span className="sr-only" role="status">{label}</span>
      <div className="workplace-loading-shape" aria-hidden="true">
        <div className="workplace-loading-nav">
          <Bar width="84px" height={18} />
          <Bar width="57px" height={18} delay=".08s" />
          <span className="skel workplace-loading-switch" />
        </div>
        <section className="workplace-loading-section">
          <RecapCard />
        </section>
        <SeatStrip />
        <section className="workplace-loading-section">
          <ShelfCard />
        </section>
      </div>
    </div>
  );
}
