import axios from "axios";
import database from "../database";

const QUERY_BOUNTY = "SELECT id FROM bounties WHERE githubUser = ? AND id = ?";
const UPDATE_BOUNTY =
  "UPDATE bounties SET releasedTo = ?, releasedAt = ? WHERE githubUser = ? AND id = ?";

export default (req, res) => {
  const githubUser = res.locals.authenticatedGithubUser.login;
  const bountyId = req.body.bountyId;
  const receiver = req.body.receiver;

  database.query(QUERY_BOUNTY, [githubUser, bountyId], (error, result) => {
    if (error) {
      res.status(500);
      res.send("Error: Reading from database failed.");
    } else if (result.length !== 1) {
      res.status(400);
      res.send("Bad Request: Bounty does not exist.");
    } else {
      // check if receiver exists
      axios
        .get("https://api.github.com/users/" + receiver)
        .then(() => {
          database.query(
            UPDATE_BOUNTY,
            [receiver, new Date(), githubUser, bountyId],
            error => {
              if (error) {
                res.status(500);
                res.send("Error: Writing to database failed.");
              } else {
                res.status(204);
                res.send();
              }
            }
          );
        })
        .catch(() => {
          res.status(400);
          res.send("Bad Request: GitHub user does not exist.");
        });
    }
  });
};
