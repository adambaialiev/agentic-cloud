import { Link } from 'react-router-dom';

export function UnknownScreen() {
  return (
    <div className="screen" id="unknownScreen">
      <div className="card authpanel">
        <h2>Nothing at this address</h2>
        <div className="authsub">This is not a Workspace address we know. Home is the honest place to start.</div>
        <div className="authlinks"><Link className="authlink" to="/">Back to Home</Link></div>
      </div>
    </div>
  );
}
