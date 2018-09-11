const AWS = require('aws-sdk');
const BoxSDK = require('box-node-sdk');
const Axios = require('axios');

exports.handler = (event, context, callback) => {
  
    //Parse event body
    var body = JSON.parse(event.body);
    console.log(body);
    var fileID = body.source.id;
    var fileName = body.source.name;
    var writeAccessToken = body.token.write.access_token;
    var readAccessToken = body.token.read.access_token;

    //Initialize Box Clients
    var boxWriteClient = new BoxSDK({clientID: 'unused', clientSecret: 'unused'}).getBasicClient(writeAccessToken);

    //Download File from Box
    var localFileName = Date.now().toString() + "_" + fileName; //add timestamp to make sure S3 key will be unique, to ensure read-after-write consistency
    var boxGetPath = "https://api.box.com/2.0/files/" + fileID + "/content?access_token=" + readAccessToken;
    Axios.get(boxGetPath, { responseType: 'arraybuffer' })
        .then(response => {
            var buffer = new Buffer(response.data, 'binary');

            //Upload File to S3
            var s3 = new AWS.S3();              
                var params = {
                    Bucket: process.env.S3_BUCKET,
                    Key: localFileName,
                    Body: buffer
                };

            s3.upload(params, function(err, data) {
                if (err) {
                    console.log(err);
                } else {
                    console.log("Object uploaded to " + params.Bucket + "/" + params.Key);

                    //AMAZON REKOGNITION CALLS START HERE
                    var rekognition = new AWS.Rekognition({apiVersion: "2016-06-27"});
                    let metadata = {cards: []}; //each keyword card from the separate Rekognition calls will be pushed to the 'cards' array
                
                    //Amazon Rekognition - DetectLabels
                    var labelParams = {
                        Image: {
                            S3Object: {
                                Bucket: process.env.S3_BUCKET,
                                Name: localFileName
                            }
                        },
                        MaxLabels: 50,
                        MinConfidence: 80
                    };
                    console.log(JSON.stringify(labelParams));

                    rekognition.detectLabels(labelParams, function(err, data){
                        if (err) {
                            console.log("ERROR on detectLabels");
                            console.log(err, err.stack);
                        } else {
                            console.log(JSON.stringify(data));
                            
                            if (data.Labels.length > 0){
                                var entries = [];
                                //Loop through the returned labels from Amazon Rekognition and add it to the 'entries' to send to Box
                                for(var i = 0; i < data.Labels.length; i++){
                                    entries.push({
                                        type: 'text',
                                        text: data.Labels[i].Name
                                    });
                                }
                                //Create a Keyword Card
                                var keywordLabels = {
                                    type: "skill_card",
                                    skill_card_type: "keyword",
                                    skill: {
                                        type: "service",
                                        id: body.skill.id
                                    },
                                    invocation: {
                                        type: "skill_invocation",
                                        id: body.id 
                                    },
                                    skill_card_title: {
                                        message: "Labels"
                                    },
                                    entries: entries
                                };
                                console.log(keywordLabels);
                                metadata.cards.push(keywordLabels);    
                            }
                        }

                        //Amazon Rekognition - DetectText
                        var sharedParams = {
                            Image: {
                                S3Object: {
                                    Bucket: process.env.S3_BUCKET,
                                    Name: localFileName
                                }
                            }
                        };

                        rekognition.detectText(sharedParams, function(err, data){
                            if (err) {
                                console.log("Error on detectText");
                                console.log(err, err.stack);
                            } else {
                                console.log(JSON.stringify(data));
                                
                                if (data.TextDetections.length > 0) {
                                    var entries = [];
                                    //Loop through response data and add to array to be sent to Box
                                    for(var i = 0; i < data.TextDetections.length; i++){
                                        if (!(data.TextDetections[i].ParentId) && data.TextDetections[i].ParentId != 0) { //Avoids repeating each word in a group as a separate entry by only returning parent strings
                                            entries.push({
                                                type: 'text',
                                                text: data.TextDetections[i].DetectedText
                                            });
                                        }
                                    }
                                    //Create a Keyword Card
                                    var keywordText = {
                                        type: "skill_card",
                                        skill_card_type: "keyword",
                                        skill: {
                                            type: "service",
                                            id: body.skill.id
                                        },
                                        invocation: {
                                            type: "skill_invocation",
                                            id: body.id 
                                        },
                                        skill_card_title: {
                                            message: "Detected Text"
                                        },
                                        entries: entries
                                    };
                                    console.log(keywordText);
                                    metadata.cards.push(keywordText);
                                }
                            }

                            //Amazon Rekognition - RecognizeCelebrities
                            //uses same parameter structure as DetectText
                            rekognition.recognizeCelebrities(sharedParams, function(err, data){
                                if (err) {
                                    console.log("ERROR on recognizeCelebrities");
                                    console.log(err, err.stack);
                                } else {
                                    console.log(JSON.stringify(data));
                                    
                                    if (data.CelebrityFaces.length > 0) {
                                        var entries = [];
                                        //Loop through response data and add to array to be sent to Box
                                        for(var i = 0; i < data.CelebrityFaces.length; i++){
                                            entries.push({
                                                type: 'text',
                                                text: data.CelebrityFaces[i].Name
                                            });
                                        }
                                        //Create a Keyword Card
                                        var keywordCeleb = {
                                            type: "skill_card",
                                            skill_card_type: "keyword",
                                            skill: {
                                                type: "service",
                                                id: body.skill.id
                                            },
                                            invocation: {
                                                type: "skill_invocation",
                                                id: body.id 
                                            },
                                            skill_card_title: {
                                                message: "Celebrities"
                                            },
                                            entries: entries
                                        };
                                        console.log(keywordCeleb);
                                        metadata.cards.push(keywordCeleb);
                                    }
                                }

                                //Amazon Rekognition - DetectModerationLabels
                                var moderationParams = {
                                    Image: {
                                        S3Object: {
                                            Bucket: process.env.S3_BUCKET,
                                            Name: localFileName
                                        }
                                    },
                                    MinConfidence: 80
                                };

                                rekognition.detectModerationLabels(moderationParams, function(err, data){
                                    if (err) {
                                        console.log("ERROR on detectModerationLabels");
                                        console.log(err, err.stack);
                                    } else {
                                        console.log(JSON.stringify(data));
                                        
                                        if(data.ModerationLabels.length > 0) {
                                            var entries = [];
                                            //Loop through the returned moderation labels from Amazon Rekognition and add it to the 'entries' to send to Box
                                            for(var i = 0; i < data.ModerationLabels.length; i++) {
                                                entries.push({
                                                    type: 'text',
                                                    text: data.ModerationLabels[i].Name
                                                });
                                            }
                                            
                                            //Create a Keyword Card
                                            var keywordModeration = {
                                                type: "skill_card",
                                                skill_card_type: "keyword",
                                                skill: {
                                                    type: "service",
                                                    id: body.skill.id
                                                },
                                                invocation: {
                                                    type: "skill_invocation",
                                                    id: body.id 
                                                },
                                                skill_card_title: {
                                                    message: "Moderation Flags"
                                                },
                                                entries: entries
                                            };
                                            console.log(keywordModeration);
                                            metadata.cards.push(keywordModeration);
                                        }
                                        //Write any keyword cards to Box File
                                        console.log(JSON.stringify(metadata));
                                        if(metadata.cards.length > 0) {
                                            boxWriteClient.files.addMetadata(fileID, 'global', 'boxSkillsCards', metadata);
                                        } 
                                    }
                                });
                            });
                        });
                    });
                }
            });
            callback(null, { statusCode: 200, body: "Success"});
        })
        .catch(error => {
            console.log(error);
        });
};
